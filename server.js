const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const xlsx = require('xlsx');
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

let questions = [
    { question: "Резервный вопрос: Как называется стек игры?", options: ["Node.js", "Python", "PHP"], correctAnswer: 1, time: 20, isFire: false }
];
let players = [];
let currentQuestionIdx = -1;
let currentAnswers = { a: 0, b: 0, c: 0 };
let timerInterval = null;
let currentTimerVal = 0;

// 1. ПАРСИНГ ЛОКАЛЬНОГО EXCEL ПРИ СТАРТЕ (РЕЗЕРВНЫЙ ВАРИАНТ)
function loadLocalExcel() {
    try {
        const workbook = xlsx.readFile(path.join(__dirname, 'вопросы.xlsx'));
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(sheet);
        parseExcelData(data);
    } catch (e) {
        console.log("Локальный Excel не найден или поврежден. Используется резервный массив.");
    }
}

function parseExcelData(rawData) {
    if (!rawData || rawData.length === 0) return;
    questions = rawData.map(row => ({
        question: row.Question || "Вопрос без текста",
        options: [row.Option1 || "", row.Option2 || "", row.Option3 || ""],
        correctAnswer: parseInt(row.CorrectAnswer) || 1,
        time: parseInt(row.Time) || 20,
        isFire: String(row.IsFire).toLowerCase() === 'да' || String(row.IsFire).toLowerCase() === 'yes'
    }));
    console.log(`База вопросов успешно обновлена. Всего вопросов: ${questions.length}`);
}

loadLocalExcel();

// 2. РАБОТА С СЕТЕВЫМИ КЛИЕНТАМИ И ЗАГРУЗКАМИ
io.on('connection', (socket) => {
    
    // Преподаватель загрузил полноценный файл Excel через браузер
    socket.on('upload_questions_file', (data) => {
        try {
            const workbook = xlsx.read(new Uint8Array(data.buffer), { type: 'array' });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const jsonRows = xlsx.utils.sheet_to_json(sheet);
            parseExcelData(jsonRows);
            currentQuestionIdx = -1; // Сбрасываем прогресс игры на начало
            socket.emit('questions_updated', { count: questions.length });
        } catch (e) {
            console.log("Ошибка парсинга загруженного файла Excel");
        }
    });

    // Преподаватель просто вставил скопированный текст таблицы из Excel
    socket.on('upload_questions_text', (data) => {
        try {
            const lines = data.text.split('\n');
            const parsedRows = [];
            lines.forEach((line, index) => {
                if (index === 0 && line.toLowerCase().includes('question')) return; // Пропускаем заголовок, если есть
                const cols = line.split('\t'); // Разделение по знаку табуляции [Вкладка из Excel]
                if (cols.length >= 5) {
                    parsedRows.push({
                        Question: cols[0], Option1: cols[1], Option2: cols[2], Option3: cols[3],
                        CorrectAnswer: cols[4], Time: cols[5] || 20, IsFire: cols[6] || 'Нет'
                    });
                }
            });
            if (parsedRows.length > 0) {
                parseExcelData(parsedRows);
                currentQuestionIdx = -1;
                socket.emit('questions_updated', { count: questions.length });
            }
        } catch (e) {
            console.log("Ошибка разбора скопированного текста вопросов");
        }
    });

    // Вход обезличенного студента (Система: Номер || Никнейм)
    socket.on('join_student', (studentData) => {
        socket.isStudent = true;
        socket.studentName = studentData.name;
        socket.score = 0;
        players.push({ id: socket.id, name: studentData.name, score: 0 });
        
        io.emit('update_players_count', { count: players.length, players: players });
    });

    // Управление раундами со стороны панели преподавателя
    socket.on('next_question', () => {
        clearInterval(timerInterval);
        currentQuestionIdx++;

        if (currentQuestionIdx >= questions.length) {
            // Конец игры: сортируем топ и выводим результаты
            players.sort((a, b) => b.score - a.score);
            socket.emit('game_over', { 
                p1: players[0] || null, 
                p2: players[1] || null, 
                p3: players[2] || null 
            });
            currentQuestionIdx = -1;
            return;
        }

        const q = questions[currentQuestionIdx];
        currentAnswers = { a: 0, b: 0, c: 0 };
        currentTimerVal = q.time;

        io.emit('new_question', { question: q.question, time: q.time, isFire: q.isFire });
        io.emit('next_question', { question: q.question, options: q.options, isFire: q.isFire });

        timerInterval = setInterval(() => {
            currentTimerVal--;
            io.emit('timer_tick', currentTimerVal);
            if (currentTimerVal <= 0) {
                clearInterval(timerInterval);
            }
        }, 1000);
    });

    // Обработка ответов участников викторины
    socket.on('submit_answer', (ansData) => {
        if (currentQuestionIdx < 0 || currentTimerVal <= 0) return;
        const q = questions[currentQuestionIdx];
        const player = players.find(p => p.id === socket.id);
        
        if (!player) return;

        let isCorrect = parseInt(ansData.answer) === q.correctAnswer;
        
        if (parseInt(ansData.answer) === 1) currentAnswers.a++;
        if (parseInt(ansData.answer) === 2) currentAnswers.b++;
        if (parseInt(ansData.answer) === 3) currentAnswers.c++;

        // Живой подсчет процентов для графика преподавателя
        let total = currentAnswers.a + currentAnswers.b + currentAnswers.c || 1;
        io.emit('update_chart', {
            a: currentAnswers.a, b: currentAnswers.b, c: currentAnswers.c,
            aPerc: Math.round((currentAnswers.a / total) * 100),
            bPerc: Math.round((currentAnswers.b / total) * 100),
            cPerc: Math.round((currentAnswers.c / total) * 100)
        });

        if (isCorrect) {
            // Если флаг "огненного вопроса" включен — начисляем х2 баллов (200 вместо 100)
            player.score += q.isFire ? 200 : 100;
            io.emit('update_players_count', { count: players.length, players: players });
        }
        socket.emit('answer_result', { isCorrect: isCorrect });
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        io.emit('update_players_count', { count: players.length, players: players });
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Локальный сервер кибер-квиза запущен на порту ${PORT}`);
});
