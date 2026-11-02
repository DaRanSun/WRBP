// 单机模拟：状态存在本机浏览器里，自己一个人填双方的 BP。棋盘渲染在 board.js，规则在 draft.js。
(function () {
    'use strict';

    const D = WRBP.draft;
    const C = WRBP.champions;
    const { $, el, button, toast, isTextField, sameRef, refOf, slotLabel, valueName } = WRBP.ui;
    const STORE_KEY = 'wrbp:v1';
    const UNDO_LIMIT = 200;

    // ---- 存档 ----
    // 存在本机浏览器里，刷新、关掉再开都还在；读不到（隐私模式、清了数据）就从新的系列赛开始。

    function loadState() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORE_KEY));
            return D.validState(saved) ? saved : null;
        } catch (error) {
            return null;
        }
    }
    function saveState() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (error) { /* 存不了就只在本页有效 */ }
    }

    let state = loadState() || D.newSeries();
    const undoStack = [];
    const redoStack = [];
    // target：点了某一格来改它（null = 按流程走，填“当前手”）。
    const ui = { target: null };

    // 所有改动都走这里：change 抛错就原样退回并提示；成功记一步撤销。change 可以返回一个新的状态来整个替换。
    function commit(change) {
        const before = JSON.stringify(state);
        const target = ui.target;
        try {
            const replaced = change(state);
            if (replaced) state = replaced;
        } catch (error) {
            state = JSON.parse(before);
            ui.target = target;
            toast(error.message);
            return false;
        }
        if (JSON.stringify(state) !== before) {
            undoStack.push(before);
            if (undoStack.length > UNDO_LIMIT) undoStack.shift();
            redoStack.length = 0;
            saveState();
        }
        render();
        return true;
    }

    function undo() {
        if (!undoStack.length) return toast('没有可以撤销的操作');
        redoStack.push(JSON.stringify(state));
        state = JSON.parse(undoStack.pop());
        ui.target = null;
        saveState();
        render();
    }

    function redo() {
        if (!redoStack.length) return toast('没有可以重做的操作');
        undoStack.push(JSON.stringify(state));
        state = JSON.parse(redoStack.pop());
        ui.target = null;
        saveState();
        render();
    }

    const teamName = team => state.teams[team].name;

    // 现在点英雄会填进哪一格：点过的那一格，否则按流程的当前手；系列赛结束或 BP 完成时没有。
    function activeRef() {
        if (D.decided(state)) return null;
        if (ui.target) return ui.target;
        const turn = D.currentTurn(state);
        return turn ? refOf(turn) : null;
    }

    // ---- 操作 ----

    function choose(slug) {
        const ref = activeRef();
        if (!ref) {
            toast(D.decided(state) ? '系列赛已经结束，点“新系列赛”重新开始' : 'BP 已完成：选出本局胜方，或者点任意一格修改');
            return false;
        }
        const ok = commit(s => {
            D.fill(s, ref, slug);
            ui.target = null;
            if (board.query) board.clearSearch();
        });
        if (!ok) board.shake(slug);
        return ok;
    }

    function skipBan() {
        const ref = activeRef();
        if (ref && ref.type === 'ban') commit(s => { D.fill(s, ref, D.EMPTY_BAN); ui.target = null; });
        board.focusSearch();
    }

    function clearSlot(ref) {
        commit(s => { D.clear(s, ref); ui.target = null; });
        board.focusSearch();
    }

    // 点某一格：改它；再点一次（或点的就是当前手）回到按流程走。
    function pickSlot(ref) {
        if (D.decided(state)) return toast('系列赛已经结束，点“新系列赛”重新开始');
        const turn = D.currentTurn(state);
        if (sameRef(ui.target, ref) || (!ui.target && turn && sameRef(refOf(turn), ref))) ui.target = null;
        else ui.target = ref;
        render();
        board.focusSearch();
    }

    function cancelTarget() {
        ui.target = null;
        render();
    }

    function newSeries() {
        ui.target = null;
        commit(s => D.newSeriesFrom(s));
    }

    const board = WRBP.board.create({
        onSlot: pickSlot,
        onTile(slug, searched) {
            if (choose(slug) && searched) board.focusSearch();
        },
        onEnter(slug, searched) {
            if (!searched) return;
            if (slug) choose(slug);
            else toast(activeRef() ? '没有能选的英雄：匹配到的都被禁用、选用或锁住了' : 'BP 已完成');
        },
        onEscape() {
            if (ui.target) cancelTarget();
        },
        onRename(team, name) {
            commit(s => { s.teams[team].name = name; });
        },
        rulesHint: '点英雄或搜索后回车填入当前手；点任意一格可以回头改；Ctrl / ⌘ + Z 撤销。',
    });

    // ---- 状态栏 ----

    function renderStatus() {
        const box = $('status');
        box.replaceChildren();
        const winner = D.decided(state);
        const ref = activeRef();
        const gameNo = state.games.length + (winner ? 0 : 1);
        const meta = el('div', 'status-meta', `第 ${gameNo} 局 · BO${state.bestOf} · ${D.FEARLESS[state.fearless].name}`);
        const main = el('div', 'status-main');
        const sub = el('div', 'status-sub');
        const actions = el('div', 'status-actions');
        const text = el('div', 'status-text');
        text.append(meta, main, sub);
        box.append(text, actions);
        delete box.dataset.editing;

        if (winner) {
            box.dataset.side = 'gold';
            main.textContent = `${teamName(winner)} 拿下系列赛`;
            sub.textContent = `${teamName('a')} ${state.score.a} : ${state.score.b} ${teamName('b')}。想接着打可以把赛制改大。`;
            actions.append(button('新系列赛', 'primary', newSeries));
            return;
        }
        if (!ref) {
            box.dataset.side = 'gold';
            main.textContent = 'BP 完成';
            sub.textContent = '选出本局胜方进入下一局（默认败方在蓝方），或者点任意一格修改';
            D.SIDES.forEach(side => {
                const team = D.teamOn(state, side);
                const win = button(`${teamName(team)} 胜`, 'win-button', () => commit(s => D.finishGame(s, team)));
                win.dataset.side = side;
                actions.append(win);
            });
            return;
        }

        const turn = D.turnOf(ref);
        box.dataset.side = ref.side;
        const team = D.teamOn(state, ref.side);
        main.append(document.createTextNode(`${D.SIDE_NAMES[ref.side]}${D.TYPE_NAMES[ref.type]}`), el('span', 'status-team', teamName(team)));
        if (ui.target) {
            box.dataset.editing = '1';
            sub.textContent = `正在修改 ${D.SIDE_NAMES[ref.side]}${slotLabel(ref)}（${turn.phaseName} · 第 ${turn.n + 1} 手）· 现在是：${valueName(D.getSlot(state, ref))}`;
        } else {
            sub.textContent = `${turn.phaseName} · 第 ${turn.n + 1} / ${D.TURNS.length} 手 · ${slotLabel(ref)}`;
        }
        if (ref.type === 'ban') actions.append(button('空 Ban', '', skipBan));
        if (ui.target && D.getSlot(state, ref) !== null) actions.append(button('清空这一格', '', () => clearSlot(ref)));
        if (ui.target) actions.append(button('取消修改', '', cancelTarget));
    }

    // ---- 顶栏 ----

    function renderControls() {
        const bestOf = $('best-of');
        if (!bestOf.options.length) {
            D.BEST_OF.forEach(n => bestOf.append(new Option(`BO${n}`, String(n))));
            Object.entries(D.FEARLESS).forEach(([key, mode]) => $('fearless').append(new Option(mode.name, key)));
        }
        bestOf.value = String(state.bestOf);
        $('fearless').value = state.fearless;
        $('fearless').title = D.FEARLESS[state.fearless].hint;
        $('swap').disabled = !D.isEmpty(state) || !!D.decided(state);
        $('undo').disabled = !undoStack.length;
        $('redo').disabled = !redoStack.length;
        $('reset-game').disabled = D.isEmpty(state);
    }

    function render() {
        renderControls();
        board.render({ state, active: activeRef(), target: ui.target, enter: '回车' });
        renderStatus();
    }

    $('best-of').addEventListener('change', event => {
        const value = Number(event.target.value);
        if (!commit(s => D.setBestOf(s, value))) renderControls();
    });
    $('fearless').addEventListener('change', event => {
        const value = event.target.value;
        if (!commit(s => D.setFearless(s, value))) renderControls();
    });
    $('swap').addEventListener('click', () => commit(s => D.swapSides(s)));
    $('undo').addEventListener('click', undo);
    $('redo').addEventListener('click', redo);
    $('reset-game').addEventListener('click', () => { ui.target = null; commit(s => D.resetGame(s)); });
    $('new-series').addEventListener('click', newSeries);

    document.addEventListener('keydown', event => {
        const typing = isTextField(event.target);
        const mod = event.metaKey || event.ctrlKey;
        const key = event.key.toLowerCase();
        if (mod && !event.altKey && (key === 'z' || key === 'y')) {
            if (typing && event.target.value) return;          // 输入框里有字时，撤销交给输入框自己
            event.preventDefault();
            if (key === 'y' || event.shiftKey) redo(); else undo();
            return;
        }
        if (!typing && !mod && event.key === 'Escape' && ui.target) cancelTarget();
    });

    // 联机入口：在 Cloudflare 上打开时用相对路径，在 Netlify 或本地文件里打开时跳到联机版的地址。
    const online = $('online-link');
    if (online && WRBP.site && WRBP.site.online && location.origin !== new URL(WRBP.site.online).origin) {
        online.href = new URL('online.html', WRBP.site.online).href;
    }

    render();
    board.focusSearch();
})();
