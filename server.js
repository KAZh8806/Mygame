const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }  // для тестов; в продакшене укажите домен
});

app.use(express.static(path.join(__dirname, 'public')));

// Хранилище комнат в памяти (для продакшена нужна БД)
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('Подключён:', socket.id);

  // Создать комнату
  socket.on('createRoom', ({ playerName }, callback) => {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    rooms.set(roomId, {
      id: roomId,
      hostSocketId: socket.id,
      players: new Map([[socket.id, { name: playerName, score: 0, connected: true }]]),
      maxPlayers: 4,
      gameState: 'lobby',  // lobby | playing | finished
      questionsPack: null,
      currentQuestion: null,
      answers: new Map(),  // socketId -> { answer, timestamp }
      roundIdx: 0,
    });
    socket.join(roomId);
    socket.roomId = roomId;
    callback({ ok: true, roomId });
    io.to(roomId).emit('roomUpdate', getRoomData(roomId));
  });

  // Присоединиться к комнате
  socket.on('joinRoom', ({ roomId, playerName }, callback) => {
    const room = rooms.get(roomId);
    if (!room) return callback({ ok: false, error: 'Комната не найдена' });
    if (room.players.size >= room.maxPlayers) return callback({ ok: false, error: 'Комната заполнена' });
    if (room.gameState !== 'lobby') return callback({ ok: false, error: 'Игра уже началась' });

    room.players.set(socket.id, { name: playerName, score: 0, connected: true });
    socket.join(roomId);
    socket.roomId = roomId;
    callback({ ok: true });
    io.to(roomId).emit('roomUpdate', getRoomData(roomId));
  });

  // Установить количество игроков
  socket.on('setMaxPlayers', ({ maxPlayers }) => {
    const room = rooms.get(socket.roomId);
    if (room && room.hostSocketId === socket.id && room.gameState === 'lobby') {
      room.maxPlayers = maxPlayers;
      io.to(room.id).emit('roomUpdate', getRoomData(room.id));
    }
  });

  // Загрузить пак вопросов
  socket.on('loadPack', ({ pack }) => {
    const room = rooms.get(socket.roomId);
    if (room && room.hostSocketId === socket.id && room.gameState === 'lobby') {
      room.questionsPack = pack;
      io.to(room.id).emit('roomUpdate', getRoomData(room.id));
    }
  });

  // Начать игру
  socket.on('startGame', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.hostSocketId !== socket.id) return;
    if (!room.questionsPack) return socket.emit('errorMsg', 'Загрузите пак вопросов');
    if (room.players.size < 2) return socket.emit('errorMsg', 'Нужно минимум 2 игрока');

    room.gameState = 'playing';
    room.roundIdx = 0;
    room.currentQuestion = getNextQuestion(room);
    io.to(room.id).emit('gameStarted');
    broadcastQuestion(room);
  });

  // Отправить ответ
  socket.on('submitAnswer', ({ answer }) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.gameState !== 'playing' || !room.currentQuestion) return;
    if (room.answers.has(socket.id)) return; // уже ответил

    room.answers.set(socket.id, {
      answer: answer.trim().toLowerCase(),
      timestamp: Date.now(),
      playerName: room.players.get(socket.id)?.name || '?'
    });

    // Если ответили все — проверяем
    if (room.answers.size >= room.players.size) {
      checkAnswers(room);
    } else {
      // Сообщаем, кто уже ответил (без раскрытия ответа)
      io.to(room.id).emit('answerProgress', {
        answeredCount: room.answers.size,
        total: room.players.size
      });
    }
  });

  // Отключение
  socket.on('disconnect', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) {
      rooms.delete(room.id);
    } else {
      if (room.hostSocketId === socket.id) {
        room.hostSocketId = room.players.keys().next().value;
      }
      io.to(room.id).emit('roomUpdate', getRoomData(room.id));
    }
  });
});

function getRoomData(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  return {
    id: room.id,
    hostSocketId: room.hostSocketId,
    players: [...room.players.entries()].map(([id, p]) => ({ id, name: p.name, score: p.score })),
    maxPlayers: room.maxPlayers,
    gameState: room.gameState,
    hasPack: !!room.questionsPack,
    packName: room.questionsPack?.name || null,
  };
}

function getNextQuestion(room) {
  const pack = room.questionsPack;
  if (!pack || !pack.rounds[room.roundIdx]) return null;
  const round = pack.rounds[room.roundIdx];
  const allQs = [];
  round.categories.forEach(cat => {
    cat.questions.forEach(q => allQs.push({ ...q, category: cat.category }));
  });
  // Простой выбор: берём первый неиспользованный (в реальности нужно отслеживать)
  return allQs[room.usedInRound || 0] || null;
}

function broadcastQuestion(room) {
  const q = room.currentQuestion;
  if (!q) {
    // Раунд закончился — переходим к следующему
    room.roundIdx++;
    if (room.roundIdx >= room.questionsPack.rounds.length) {
      room.gameState = 'finished';
      io.to(room.id).emit('gameFinished', getFinalScores(room));
      return;
    }
    room.usedInRound = 0;
    room.currentQuestion = getNextQuestion(room);
    io.to(room.id).emit('newRound', { roundIdx: room.roundIdx });
    if (room.currentQuestion) setTimeout(() => broadcastQuestion(room), 2000);
    return;
  }

  room.answers.clear();
  io.to(room.id).emit('newQuestion', {
    question: q.q,
    price: q.price * (room.questionsPack.rounds[room.roundIdx].multiplier || 1),
    category: q.category,
    round: room.roundIdx + 1,
    answers: q.answers,
  });
}

function checkAnswers(room) {
  const q = room.currentQuestion;
  if (!q) return;
  const results = [];
  const price = q.price * (room.questionsPack.rounds[room.roundIdx].multiplier || 1);

  // Сортируем по времени ответа
  const sorted = [...room.answers.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);

  for (const [socketId, data] of sorted) {
    const player = room.players.get(socketId);
    if (!player) continue;
    const correct = q.answers.some(a => 
      data.answer === a.toLowerCase().trim() ||
      data.answer.includes(a.toLowerCase().trim()) ||
      a.toLowerCase().trim().includes(data.answer)
    );
    if (correct) {
      player.score += price;
    } else {
      player.score -= price;
    }
    results.push({
      name: player.name,
      answer: data.answer,
      correct,
      score: player.score,
      time: data.timestamp
    });
  }

  // Остальные (кто не ответил) получают 0
  for (const [socketId, player] of room.players) {
    if (!room.answers.has(socketId)) {
      results.push({ name: player.name, answer: '(нет ответа)', correct: false, score: player.score, time: Infinity });
    }
  }

  room.usedInRound = (room.usedInRound || 0) + 1;
  room.currentQuestion = null;

  io.to(room.id).emit('answerResults', {
    correctAnswer: q.answers[0],
    results,
    price,
  });

  // Через 4 секунды — следующий вопрос
  setTimeout(() => {
    if (room.gameState === 'playing') {
      room.currentQuestion = getNextQuestion(room);
      broadcastQuestion(room);
    }
  }, 4000);
}

function getFinalScores(room) {
  return [...room.players.entries()]
    .map(([id, p]) => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер на порту ${PORT}`));