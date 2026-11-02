// 联机房间：连上房间（Durable Object）的 WebSocket，收完整状态、发操作。
// 教练、裁判、观战是同一个页面，身份由链接里的口令决定（服务器判定，页面只负责显示）。
// 棋盘渲染在 board.js，BP 规则在 draft.js，房间规则在 worker/room-logic.mjs（服务器上执行）。
(function () {
    'use strict';

    const D = WRBP.draft;
    const C = WRBP.champions;
    const { $, el, button, toast, copyText, isTextField, sameRef, refOf, slotLabel, valueName } = WRBP.ui;

    const params = new URLSearchParams(location.search);
    const roomId = (params.get('r') || '').toLowerCase();
    const key = params.get('k') || '';
    const PING_MS = 20000;

    const me = { role: null, tokens: null };
    let room = null;            // 服务器推来的房间状态（worker/room-logic.mjs 的 snapshot）
    let presence = null;        // 各身份在线几个
    let can = null;             // 这个身份能做哪些需要权限的操作
    let target = null;          // 裁判点了某一格来改它
    let socket = null;
    let retry = 0;
    let retryTimer = 0;
    let pingTimer = 0;
    let lastPong = Date.now();
    let gone = false;
    let wasMyTurn = false;

    const isCoach = role => role === 'a' || role === 'b';
    const teamName = team => room.series.teams[team].name;
    const roleName = role => (role === 'ref' ? '裁判' : role === 'view' ? '观战' : `${teamName(role)} 教练`);

    function fatal(message) {
        gone = true;
        clearTimeout(retryTimer);
        clearInterval(pingTimer);
        const box = $('fatal');
        box.hidden = false;
        box.replaceChildren();
        const card = el('div', 'fatal-card');
        const back = el('a', 'button-link primary', '回联机大厅');
        back.href = 'online';
        card.append(el('h1', '', message), back);
        box.append(card);
    }

    if (!/^[a-z0-9]{6}$/.test(roomId)) {
        fatal('链接里没有房间号');
        return;
    }
    $('room-code').textContent = `房间 ${roomId}`;

    // ---- 连接 ----

    function setConnected(ok) {
        $('conn-dot').classList.toggle('is-on', ok);
        $('conn-dot').title = ok ? '已连接' : '连接中断';
        const banner = $('conn-banner');
        banner.hidden = ok || !room;
        banner.textContent = '连接断开，正在重连…（重连之前的操作不会生效）';
    }

    function connect() {
        if (gone) return;
        const url = new URL(`/api/rooms/${roomId}/ws`, location.href);
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        if (key) url.searchParams.set('k', key);
        const ws = new WebSocket(url.href);
        socket = ws;
        ws.addEventListener('open', () => {
            retry = 0;
            lastPong = Date.now();
            setConnected(true);
            clearInterval(pingTimer);
            pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, PING_MS);
        });
        ws.addEventListener('message', event => {
            if (event.data === 'pong') {
                lastPong = Date.now();
                return;
            }
            let message;
            try { message = JSON.parse(event.data); } catch (error) { return; }
            receive(message);
        });
        ws.addEventListener('close', () => {
            if (socket !== ws) return;
            clearInterval(pingTimer);
            setConnected(false);
            if (!gone) retryTimer = setTimeout(connect, Math.min(500 * 2 ** retry++, 8000));
        });
    }

    // 手机切到后台再回来时，连接可能已经悄悄断了：先 ping 一下，3 秒没回音就重连。
    function checkConnection() {
        if (gone) return;
        if (!socket || socket.readyState > 1) {
            clearTimeout(retryTimer);
            retry = 0;
            connect();
            return;
        }
        if (socket.readyState !== 1) return;
        const sentAt = Date.now();
        const ws = socket;
        ws.send('ping');
        setTimeout(() => { if (socket === ws && lastPong < sentAt) ws.close(); }, 3000);
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkConnection(); });
    window.addEventListener('online', checkConnection);

    function receive(message) {
        if (message.type === 'hello') {
            me.role = message.role;
            me.tokens = message.tokens;
            if (message.badKey) toast('链接里的身份口令不对，已按观战进入');
        } else if (message.type === 'state') {
            const before = room && room.proposal;
            room = message.room;
            presence = message.presence;
            can = message.can;
            if (target && (D.decided(room.series) || !D.turnOf(target))) target = null;
            if (room.proposal && (!before || before.id !== room.proposal.id) && isCoach(me.role) && room.proposal.by !== me.role) {
                toast(`${teamName(room.proposal.by)} 请求：${room.proposal.label}`);
                buzz();
            }
            setConnected(true);
            render();
        } else if (message.type === 'error') {
            toast(message.message);
        } else if (message.type === 'gone') {
            fatal('房间不存在或已过期（14 天没人操作会自动删除）');
        }
    }

    function send(command) {
        if (!socket || socket.readyState !== 1) {
            toast('连接断开了，正在重连…');
            checkConnection();
            return false;
        }
        socket.send(JSON.stringify(command));
        return true;
    }

    function buzz() {
        if (navigator.vibrate) {
            try { navigator.vibrate(80); } catch (error) { /* 不支持就算了 */ }
        }
    }

    // ---- 当前局面 ----

    function currentTurn() {
        return room && !D.decided(room.series) ? D.currentTurn(room.series) : null;
    }

    // 轮到我（教练）的那一手，没轮到是 null。
    function myTurn() {
        const turn = currentTurn();
        return turn && isCoach(me.role) && D.sideOf(room.series, me.role) === turn.side ? turn : null;
    }

    function hover() {
        const turn = currentTurn();
        return turn && room.hover && room.hover.turn === turn.n ? { ref: refOf(turn), slug: room.hover.slug } : null;
    }

    function activeRef() {
        if (!room || D.decided(room.series)) return null;
        if (me.role === 'ref' && target) return target;
        const turn = D.currentTurn(room.series);
        return turn ? refOf(turn) : null;
    }

    function waitingText() {
        const turn = currentTurn();
        if (!turn) return D.decided(room.series) ? '系列赛已经结束' : 'BP 已完成';
        return `还没轮到你，现在是 ${teamName(D.teamOn(room.series, turn.side))} ${D.TYPE_NAMES[turn.type]}`;
    }

    // ---- 操作 ----

    function afterPick() {
        if (board.query) board.clearSearch();
        render();
    }

    // 点了英雄（或搜索后回车）：裁判直接填进当前格；轮到的教练是预选。
    function choose(slug) {
        if (!room) return false;
        if (me.role === 'ref') {
            const ref = activeRef();
            if (!ref) {
                toast(D.decided(room.series) ? '系列赛已经结束' : 'BP 已完成：点任意一格来改它，或者记录胜负');
                return false;
            }
            const reason = D.blockedReason(room.series, ref, slug);
            if (reason) {
                toast(reason);
                board.shake(slug);
                return false;
            }
            if (!send({ type: 'fill', ref, value: slug })) return false;
            target = null;
            afterPick();
            return true;
        }
        if (isCoach(me.role)) {
            const turn = myTurn();
            if (!turn) {
                toast(waitingText());
                return false;
            }
            const reason = D.blockedReason(room.series, turn, slug);
            if (reason) {
                toast(reason);
                board.shake(slug);
                return false;
            }
            if (!send({ type: 'hover', slug, turn: turn.n })) return false;
            afterPick();
            return true;
        }
        toast('观战只能看，不能操作');
        return false;
    }

    function lock() {
        const turn = myTurn();
        const current = hover();
        if (!turn) return toast(waitingText());
        if (!current) return toast('先点一个英雄预选，再锁定');
        send({ type: 'lock', slug: current.slug, turn: turn.n });
    }

    function skipBan() {
        if (me.role === 'ref') {
            const ref = activeRef();
            if (ref && ref.type === 'ban' && send({ type: 'fill', ref, value: D.EMPTY_BAN })) target = null;
            return;
        }
        const turn = myTurn();
        if (turn && turn.type === 'ban') send({ type: 'skip', turn: turn.n });
    }

    // 需要权限的操作：能直接做就做，双端的教练是发请求。
    function privileged(type, extra) {
        const perm = type === 'finish' ? can && can.finish[extra.winner] : can && can[type];
        if (!perm) return toast('现在不能这样做');
        if (send(Object.assign({ type }, extra)) && perm === 'propose') toast('已发出请求，等对方同意');
    }

    function respond(accept) {
        if (room.proposal) send({ type: 'respond', id: room.proposal.id, accept });
    }

    function cancelProposal() {
        if (room.proposal) send({ type: 'cancel', id: room.proposal.id });
    }

    const board = WRBP.board.create({
        onSlot(ref) {
            if (me.role !== 'ref' || !room) return;
            if (D.decided(room.series)) return toast('系列赛已经结束');
            const turn = D.currentTurn(room.series);
            if (sameRef(target, ref) || (!target && turn && sameRef(refOf(turn), ref))) target = null;
            else target = ref;
            render();
            board.focusSearch();
        },
        onTile(slug, searched) {
            if (choose(slug) && searched) board.focusSearch();
        },
        onEnter(slug, searched) {
            if (!room) return;
            if (!searched) {
                if (myTurn() && hover()) lock();             // 搜索框空着时回车 = 锁定预选
                return;
            }
            if (slug) choose(slug);
            else if (me.role === 'ref' || myTurn()) toast('没有能选的英雄：匹配到的都被禁用、选用或锁住了');
            else toast(isCoach(me.role) ? waitingText() : '观战只能看，不能操作');
        },
        onEscape() {
            if (target) {
                target = null;
                render();
            }
        },
        onRename(team, name) {
            send({ type: 'rename', team, name });
        },
        rulesHint: '联机：轮到你时点英雄是预选，点“锁定”（或搜索框空着时按回车）才算数；撤销、记胜负、换边、改设置三端由裁判做，双端要对方同意。',
    });

    // ---- 顶栏 ----

    function renderTop() {
        document.title = `${wasMyTurn ? '【轮到你】' : ''}WRBP · ${teamName('a')} vs ${teamName('b')}`;
        const badge = $('role-badge');
        badge.textContent = `你是 ${roleName(me.role)}`;
        badge.dataset.side = isCoach(me.role) ? D.sideOf(room.series, me.role) : me.role;

        const box = $('presence');
        box.replaceChildren();
        const pill = (label, online, title) => {
            const node = el('span', 'pill', label);
            node.classList.toggle('is-on', online);
            node.title = title;
            box.append(node);
        };
        ['a', 'b'].forEach(team => pill(`${teamName(team)} 教练`, presence[team] > 0, presence[team] > 0 ? '在线' : '不在线'));
        if (room.mode === 'trio') pill('裁判', presence.ref > 0, presence.ref > 0 ? '在线' : '不在线');
        if (presence.view > 0) pill(`观战 ${presence.view}`, true, `${presence.view} 人在观战`);
    }

    function renderControls() {
        const bestOf = $('best-of');
        if (!bestOf.options.length) {
            D.BEST_OF.forEach(n => bestOf.append(new Option(`BO${n}`, String(n))));
            Object.entries(D.FEARLESS).forEach(([value, mode]) => $('fearless').append(new Option(mode.name, value)));
        }
        const role = me.role;
        let any = false;
        document.querySelectorAll('[data-control]').forEach(node => {
            const perm = can[node.dataset.control];
            // 裁判、双端教练看得到全部（做不了的是灰的）；三端教练只看得到自己能做的（败方选边）；观战都看不到。
            node.hidden = !(perm || role === 'ref' || (isCoach(role) && room.mode === 'duo'));
            any = any || !node.hidden;
            const control = node.tagName === 'LABEL' ? node.querySelector('select') : node;
            control.disabled = !perm;
            if (node.tagName === 'BUTTON') {
                node.dataset.label = node.dataset.label || node.textContent;
                node.textContent = perm === 'propose' ? `${node.dataset.label}…` : node.dataset.label;
                node.title = perm === 'propose' ? '要对方同意' : '';
            } else {
                control.title = perm === 'propose' ? '改了要对方同意' : '';
            }
        });
        document.querySelector('.controls .sep').hidden = !any;
        bestOf.value = String(room.series.bestOf);
        $('fearless').value = room.series.fearless;
    }

    $('best-of').addEventListener('change', event => {
        privileged('settings', { bestOf: Number(event.target.value) });
        renderControls();
    });
    $('fearless').addEventListener('change', event => {
        privileged('settings', { fearless: event.target.value });
        renderControls();
    });
    $('swap').addEventListener('click', () => privileged('swap', {}));
    $('undo').addEventListener('click', () => privileged('undo', {}));
    $('reset-game').addEventListener('click', () => { target = null; privileged('reset', {}); });
    $('new-series').addEventListener('click', () => { target = null; privileged('newSeries', {}); });

    // ---- 分享链接 ----

    function roomUrl(token) {
        const url = new URL('room', location.href);
        url.search = new URLSearchParams(token ? { r: roomId, k: token } : { r: roomId }).toString();
        return url.href;
    }

    $('share').addEventListener('click', () => {
        const list = $('share-links');
        list.replaceChildren();
        const items = [];
        if (me.role === 'ref' && me.tokens) {
            items.push({ role: '裁判（你）', url: roomUrl(me.tokens.ref) });
            items.push({ role: `${teamName('a')} 教练`, url: roomUrl(me.tokens.a) });
            items.push({ role: `${teamName('b')} 教练`, url: roomUrl(me.tokens.b) });
        } else if (isCoach(me.role)) {
            items.push({ role: `${teamName(me.role)} 教练（你，换设备用）`, url: roomUrl(key) });
        }
        items.push({ role: '观战（谁都能看，可当 OBS 浏览器源）', url: roomUrl(null) });
        items.forEach(item => {
            const row = el('div', 'link-row');
            const info = el('div', 'link-info');
            info.append(el('strong', '', item.role), el('code', 'link-url', item.url));
            row.append(info, button('复制', '', () => copyText(item.url, '已复制链接')));
            list.append(row);
        });
        $('share-dialog').showModal();
    });

    // ---- 状态栏、请求 ----

    function renderNotice() {
        const box = $('notice');
        box.replaceChildren();
        const proposal = room.proposal;
        if (proposal) {
            box.hidden = false;
            box.dataset.kind = 'proposal';
            const other = D.OTHER[proposal.by];
            const text = el('span', 'notice-text');
            const actions = el('span', 'notice-actions');
            if (me.role === other) {
                text.textContent = `${teamName(proposal.by)} 请求：${proposal.label}`;
                actions.append(button('同意', 'primary', () => respond(true)), button('拒绝', '', () => respond(false)));
            } else if (me.role === proposal.by) {
                text.textContent = `已请求：${proposal.label}，等 ${teamName(other)} 同意`;
                actions.append(button('撤回', '', cancelProposal));
            } else {
                text.textContent = `${teamName(proposal.by)} 请求：${proposal.label}，等 ${teamName(other)} 同意`;
            }
            box.append(text, actions);
        } else if (room.last) {
            box.hidden = false;
            box.dataset.kind = 'last';
            box.append(el('span', 'notice-text', `最近：${room.last}`));
        } else {
            box.hidden = true;
        }
    }

    function renderStatus() {
        const box = $('status');
        box.replaceChildren();
        const series = room.series;
        const winner = D.decided(series);
        const gameNo = series.games.length + (winner ? 0 : 1);
        const meta = el('div', 'status-meta', `第 ${gameNo} 局 · BO${series.bestOf} · ${D.FEARLESS[series.fearless].name} · ${room.mode === 'trio' ? '三端' : '双端'}`);
        const main = el('div', 'status-main');
        const sub = el('div', 'status-sub');
        const actions = el('div', 'status-actions');
        const text = el('div', 'status-text');
        text.append(meta, main, sub);
        box.append(text, actions);
        delete box.dataset.editing;
        delete box.dataset.waiting;

        if (winner) {
            box.dataset.side = 'gold';
            main.textContent = `${teamName(winner)} 拿下系列赛`;
            sub.textContent = `${teamName('a')} ${series.score.a} : ${series.score.b} ${teamName('b')}。想接着打可以把赛制改大。`;
            if (can.newSeries) actions.append(button(can.newSeries === 'propose' ? '新系列赛…' : '新系列赛', 'primary', () => privileged('newSeries', {})));
            return;
        }

        const ref = activeRef();
        if (!ref) {
            box.dataset.side = 'gold';
            main.textContent = 'BP 完成';
            const finishers = ['a', 'b'].filter(team => can.finish[team]);
            sub.textContent = finishers.length
                ? '记下本局胜方进入下一局（默认败方在蓝方）' + (me.role === 'ref' ? '，或者点任意一格修改' : '')
                : room.mode === 'trio' ? '等裁判记录胜负' : '等教练记录胜负';
            D.SIDES.forEach(side => {
                const team = D.teamOn(series, side);
                const perm = can.finish[team];
                if (!perm) return;
                const label = isCoach(me.role) && team !== me.role ? `${teamName(team)} 胜（认输）`
                    : perm === 'propose' ? `${teamName(team)} 胜（要对方同意）` : `${teamName(team)} 胜`;
                const win = button(label, 'win-button', () => privileged('finish', { winner: team }));
                win.dataset.side = side;
                actions.append(win);
            });
            return;
        }

        const turn = D.turnOf(ref);
        const team = D.teamOn(series, ref.side);
        const preview = hover();
        box.dataset.side = ref.side;
        const progress = `${turn.phaseName} · 第 ${turn.n + 1} / ${D.TURNS.length} 手 · ${slotLabel(ref)}`;

        if (me.role === 'ref') {
            main.append(document.createTextNode(`${D.SIDE_NAMES[ref.side]}${D.TYPE_NAMES[ref.type]}`), el('span', 'status-team', teamName(team)));
            if (target) {
                box.dataset.editing = '1';
                sub.textContent = `正在修改 ${D.SIDE_NAMES[ref.side]}${slotLabel(ref)}（第 ${turn.n + 1} 手）· 现在是：${valueName(D.getSlot(series, ref))}`;
            } else {
                sub.textContent = `${progress}${preview ? ` · 预选 ${C.name(preview.slug)}` : ''} · 点英雄直接替这一方锁定`;
            }
            if (ref.type === 'ban') actions.append(button('空 Ban', '', skipBan));
            if (target && D.getSlot(series, ref) !== null) {
                actions.append(button('清空这一格', '', () => {
                    if (send({ type: 'fill', ref: target, value: null })) target = null;
                }));
            }
            if (target) actions.append(button('取消修改', '', () => { target = null; render(); }));
            return;
        }

        if (myTurn()) {
            main.append(document.createTextNode(`轮到你 · ${D.TYPE_NAMES[ref.type]}`), el('span', 'status-team', preview ? `预选：${C.name(preview.slug)}` : '点一个英雄预选'));
            sub.textContent = progress;
            const lockButton = button(preview ? `锁定 ${C.name(preview.slug)}` : '锁定', 'primary lock-button', lock);
            lockButton.disabled = !preview;
            actions.append(lockButton);
            if (ref.type === 'ban') actions.append(button('空 Ban', '', skipBan));
            return;
        }

        box.dataset.waiting = '1';
        const verb = D.TYPE_NAMES[ref.type];
        main.append(document.createTextNode(isCoach(me.role) ? `等待 ${teamName(team)} ${verb}` : `${D.SIDE_NAMES[ref.side]}${verb}`),
            el('span', 'status-team', preview ? `预选：${C.name(preview.slug)}` : isCoach(me.role) ? '' : teamName(team)));
        sub.textContent = progress + (presence[team] > 0 ? '' : ` · ${teamName(team)} 教练不在线`);
    }

    function render() {
        if (!room || !me.role) return;
        const mine = !!myTurn();
        if (mine && !wasMyTurn) buzz();
        wasMyTurn = mine;
        renderTop();
        renderControls();
        const enter = me.role === 'ref' ? '回车' : mine ? '回车预选' : '';
        board.render({
            state: room.series,
            active: activeRef(),
            target: me.role === 'ref' ? target : null,
            hover: hover(),
            you: isCoach(me.role) ? me.role : null,
            slots: me.role === 'ref',
            canRename: team => me.role === 'ref' || me.role === team,
            enter,
        });
        renderNotice();
        renderStatus();
        document.body.dataset.role = me.role;
    }

    document.addEventListener('keydown', event => {
        if (isTextField(event.target) && event.target.value) return;
        const mod = event.metaKey || event.ctrlKey;
        if (mod && !event.altKey && event.key.toLowerCase() === 'z' && me.role === 'ref') {
            event.preventDefault();
            privileged('undo', {});
        } else if (!mod && event.key === 'Escape' && target) {
            target = null;
            render();
        }
    });

    $('status').textContent = '连接中…';
    connect();
    board.focusSearch();
})();
