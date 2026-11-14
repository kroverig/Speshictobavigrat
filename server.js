const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const QUESTIONS = [
  { q:'Сколько будет 7 × 8?', answers:[{icon:'🐟',v:56},{icon:'🚀',v:54},{icon:'🍎',v:49}], correct:0 },
  { q:'Какое животное — млекопитающее?', answers:[{icon:'🐍',v:'змея'},{icon:'🐬',v:'дельфин'},{icon:'🐟',v:'рыба'}], correct:1 },
  { q:'Столица России?', answers:[{icon:'🗼',v:'Париж'},{icon:'🏰',v:'Москва'},{icon:'🗽',v:'Нью-Йорк'}], correct:1 },
  { q:'Сколько планет в Солнечной системе?', answers:[{icon:'🪐',v:8},{icon:'🌞',v:9},{icon:'🌍',v:7}], correct:0 },
  { q:'Формула воды?', answers:[{icon:'💧',v:'H2O'},{icon:'🔥',v:'CO2'},{icon:'❄️',v:'O2'}], correct:0 },
];

const state = {
  phase: 'lobby',
  phaseStart: 0,
  prepDuration: 120000,
  players: {},
  teacher: { x:0, z:-10, target:null, cooldown:0, patrol:0, aggression:0 },
  currentQuestion: 0,
  answers: {},
  drawings: []
};

function phaseLeft(dur) {
  return Math.max(0, Math.ceil((dur - (Date.now() - state.phaseStart)) / 1000));
}

function getLobbyState() {
  const players = {};
  for (const id in state.players) {
    const p = state.players[id];
    players[id] = { name: p.name, ready: p.ready, color: p.color };
  }
  return { players };
}

function checkStart() {
  if (state.phase !== 'lobby') return;
  const ids = Object.keys(state.players);
  if (ids.length === 0) return;
  const allReady = ids.every(id => state.players[id].ready);
  if (!allReady) return;
  state.phase = 'prep';
  state.phaseStart = Date.now();
  for (const id in state.players) {
    const p = state.players[id];
    p.ready = false;
    p.x = 0; p.z = 5;
  }
  io.emit('phase', 'prep');
}

setInterval(() => {
  if (state.phase !== 'prep') return;
  io.emit('prepTimer', phaseLeft(state.prepDuration));
  if (phaseLeft(state.prepDuration) <= 0) {
    state.phase = 'exam';
    state.phaseStart = Date.now();
    state.answers = {};
    pickQuestion();
    io.emit('phase', 'exam');
  }
}, 500);

setInterval(() => {
  const t = state.teacher;

  if (state.phase !== 'exam') {
    t.aggression = 0;
    t.x = 0; t.z = -10;
    io.to('players').emit('teacherPos', { x:t.x, z:t.z, aggression:0, target:null });
    return;
  }

  const elapsed = (Date.now() - state.phaseStart) / 1000;
  let base = Math.min(100, elapsed / 120 * 100);
  let boost = 0, standing = false;
  for (const id in state.players) {
    const p = state.players[id];
    boost += p.noise * 5;
    if (!p.sitting && p.z < -5) standing = true;
  }
  if (standing) boost += 10;
  t.aggression = Math.min(100, base + boost);

  let loudest = null;
  if (t.aggression > 35) {
    let maxN = 0.3;
    for (const id in state.players) {
      const p = state.players[id];
      if (p.noise > maxN) { maxN = p.noise; loudest = id; }
    }
  }
  if (!loudest && t.aggression > 55) {
    for (const id in state.players) {
      const p = state.players[id];
      if (!p.sitting && p.z < -4) { loudest = id; break; }
    }
  }

  if (loudest) {
    t.target = loudest;
    const p = state.players[loudest];
    const dx = p.x - t.x, dz = p.z - t.z;
    const dist = Math.hypot(dx, dz);
    const speed = 0.05 + t.aggression / 100 * 0.15;
    if (dist > 1.5) { t.x += (dx/dist)*speed; t.z += (dz/dist)*speed; }
    else if (t.cooldown <= 0 && t.aggression > 55) {
      const item = Math.random() < .5 ? 'мелок' : 'линейка';
      const dmg = t.aggression > 85 ? 10 : 5;
      p.score = Math.max(0, p.score - dmg);
      p.noise = 0;
      t.cooldown = Math.max(10, 50 - t.aggression / 2);
      io.to('players').emit('hit', { targetId: loudest, item, dmg });
    }
  } else {
    t.target = null;
    t.patrol = (t.patrol + 1 + t.aggression / 50) % 200;
    const a = t.patrol / 200 * Math.PI * 2;
    const r = 3 + t.aggression / 100 * 3;
    t.x = Math.sin(a) * r;
    t.z = -6 + Math.cos(a) * r;
  }
  if (t.cooldown > 0) t.cooldown--;

  io.to('players').emit('teacherPos', { x:t.x, z:t.z, aggression:t.aggression, target:t.target });
}, 100);

function pickQuestion() {
  state.currentQuestion = Math.floor(Math.random() * QUESTIONS.length);
  state.answers = {};
  io.emit('question', QUESTIONS[state.currentQuestion]);
}

io.on('connection', socket => {
  socket.on('join', ({ name, color }) => {
    state.players[socket.id] = {
      id: socket.id, name: name || 'Ученик', color: color || '#00aaff',
      x: 0, z: 0, sitting: false, noise: 0, score: 0,
      hands: [null, null], ready: false
    };
    socket.join('players');
    socket.emit('state', {
      phase: state.phase,
      players: state.players,
      drawings: state.drawings,
      prepLeft: phaseLeft(state.prepDuration),
      question: state.phase === 'exam' ? QUESTIONS[state.currentQuestion] : null
    });
    if (state.phase === 'lobby') {
      io.emit('lobbyState', getLobbyState());
      checkStart();
    }
  });

  socket.on('ready', (isReady) => {
    const p = state.players[socket.id]; if (!p) return;
    p.ready = !!isReady;
    io.emit('lobbyState', getLobbyState());
    checkStart();
  });

  socket.on('customize', ({ color }) => {
    const p = state.players[socket.id]; if (!p) return;
    p.color = color;
    if (state.phase === 'lobby') io.emit('lobbyState', getLobbyState());
  });

  socket.on('move', ({ x, z, sitting }) => {
    const p = state.players[socket.id]; if (!p) return;
    Object.assign(p, { x, z, sitting });
  });

  socket.on('noise', level => {
    const p = state.players[socket.id]; if (!p) return;
    p.noise = level;
  });

  socket.on('putItem', ({ slot, item }) => {
    const p = state.players[socket.id]; if (!p) return;
    if (slot < 0 || slot > 1) return;
    if (item && !['paper','pencil'].includes(item.type)) return;
    p.hands[slot] = item;
  });

  socket.on('writeHint', ({ slot, hint }) => {
    if (state.phase !== 'prep') return;
    const p = state.players[socket.id]; if (!p) return;
    const it = p.hands[slot];
    if (it && it.type === 'paper') it.hint = String(hint).slice(0, 30);
  });

  socket.on('useHint', ({ slot }) => {
    if (state.phase !== 'exam') return;
    const p = state.players[socket.id]; if (!p) return;
    const it = p.hands[slot];
    if (it && it.type === 'paper' && it.hint) {
      socket.emit('hintRevealed', { hint: it.hint });
      p.hands[slot] = null;
    }
  });

  socket.on('draw', stroke => {
    if (state.phase !== 'prep' && state.phase !== 'exam') return;
    if (!stroke || !stroke.points || stroke.points.length < 2) return;
    state.drawings.push(stroke);
    if (state.drawings.length > 2000) state.drawings.shift();
    socket.broadcast.emit('draw', stroke);
  });

  socket.on('answer', idx => {
    if (state.phase !== 'exam') return;
    const p = state.players[socket.id];
    if (!p || state.answers[socket.id] !== undefined) return;
    state.answers[socket.id] = idx;
    const correct = idx === QUESTIONS[state.currentQuestion].correct;
    if (correct) p.score += 10;
    socket.emit('answerResult', { correct, score: p.score });
  });

  socket.on('disconnect', () => {
    delete state.players[socket.id];
    if (state.phase === 'lobby') {
      io.emit('lobbyState', getLobbyState());
      checkStart();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('Сервер на порту ' + PORT));
