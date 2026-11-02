// 联机大厅：建房、拿到各身份的链接、看自己建过的房间、按房间号观战。
(function () {
    'use strict';

    const D = WRBP.draft;
    const RECENT_KEY = 'wrbp:rooms';
    const RECENT_LIMIT = 20;
    const $ = id => document.getElementById(id);

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    let toastTimer = 0;
    function toast(message) {
        const node = $('toast');
        node.textContent = message;
        node.classList.add('is-on');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => node.classList.remove('is-on'), 2600);
    }

    function copy(text, done) {
        const fallback = () => {
            const area = el('textarea');
            area.value = text;
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.append(area);
            area.select();
            let ok = false;
            try { ok = document.execCommand('copy'); } catch (error) { ok = false; }
            area.remove();
            toast(ok ? done : '复制失败，长按链接手动复制');
        };
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => toast(done), fallback);
        else fallback();
    }

    // 建过的房间记在本机浏览器里（含各身份口令），方便回头再拿链接。
    function loadRecent() {
        try {
            const list = JSON.parse(localStorage.getItem(RECENT_KEY));
            return Array.isArray(list) ? list : [];
        } catch (error) {
            return [];
        }
    }
    function saveRecent(list) {
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_LIMIT))); } catch (error) { /* 记不住就算了 */ }
    }

    const roomUrl = (id, token) => {
        const url = new URL('room', location.href);
        url.search = new URLSearchParams(token ? { r: id, k: token } : { r: id }).toString();
        return url.href;
    };

    // 某个房间的各身份链接：谁该拿哪个。
    function links(room) {
        const a = room.teams.a;
        const b = room.teams.b;
        const list = [];
        if (room.mode === 'trio') list.push({ role: '裁判', who: '你自己（或裁判）打开', url: roomUrl(room.id, room.tokens.ref), primary: true });
        list.push({ role: `${a} 教练`, who: room.mode === 'trio' ? `发给 ${a} 的教练` : `你自己打开（${a}）`, url: roomUrl(room.id, room.tokens.a), primary: room.mode === 'duo' });
        list.push({ role: `${b} 教练`, who: `发给 ${b} 的教练`, url: roomUrl(room.id, room.tokens.b) });
        list.push({ role: '观战', who: '谁都可以看，也能当 OBS 浏览器源', url: roomUrl(room.id) });
        return list;
    }

    function showCreated(room) {
        const box = $('created');
        box.hidden = false;
        box.replaceChildren();
        const head = el('div', 'created-head');
        head.append(el('h2', '', `房间 ${room.id}`),
            el('span', 'created-meta', `${room.mode === 'trio' ? '三端' : '双端'} · ${room.teams.a} vs ${room.teams.b} · BO${room.bestOf} · ${D.FEARLESS[room.fearless].name}`));
        box.append(head);
        const list = el('div', 'link-list');
        links(room).forEach(item => {
            const row = el('div', 'link-row');
            const info = el('div', 'link-info');
            info.append(el('strong', '', item.role), el('span', 'link-who', item.who), el('code', 'link-url', item.url));
            const actions = el('div', 'link-actions');
            const copyButton = el('button', '', '复制');
            copyButton.type = 'button';
            copyButton.addEventListener('click', () => copy(item.url, `已复制${item.role}链接`));
            const open = el('a', item.primary ? 'button-link primary' : 'button-link', '打开');
            open.href = item.url;
            actions.append(copyButton, open);
            row.append(info, actions);
            list.append(row);
        });
        box.append(list);
        const all = el('button', 'copy-all', '复制全部链接（发到群里）');
        all.type = 'button';
        all.addEventListener('click', () => {
            const text = [`WRBP 联机 BP · 房间 ${room.id} · ${room.teams.a} vs ${room.teams.b}`]
                .concat(links(room).filter(item => item.role !== '裁判').map(item => `${item.role}：${item.url}`)).join('\n');
            copy(text, '已复制（不含裁判链接）');
        });
        box.append(all, el('p', 'form-note', '教练链接等于这一队的身份，只发给对应的教练。裁判链接自己留着。'));
        box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function renderRecent() {
        const recent = loadRecent();
        const box = $('recent');
        box.hidden = !recent.length;
        box.replaceChildren(el('h2', '', '我建过的房间'));
        const list = el('div', 'recent-list');
        recent.forEach(room => {
            const row = el('div', 'recent-row');
            const info = el('div', 'link-info');
            const date = new Date(room.createdAt);
            info.append(el('strong', '', `${room.id} · ${room.teams.a} vs ${room.teams.b}`),
                el('span', 'link-who', `${room.mode === 'trio' ? '三端' : '双端'} · BO${room.bestOf} · ${date.getMonth() + 1} 月 ${date.getDate()} 日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`));
            const actions = el('div', 'link-actions');
            const show = el('button', '', '链接');
            show.type = 'button';
            show.addEventListener('click', () => showCreated(room));
            const remove = el('button', '', '删除');
            remove.type = 'button';
            remove.title = '只删掉本机的记录，房间本身 14 天没人用会自动删除';
            remove.addEventListener('click', () => {
                saveRecent(loadRecent().filter(item => item.id !== room.id));
                renderRecent();
            });
            actions.append(show, remove);
            row.append(info, actions);
            list.append(row);
        });
        box.append(list);
    }

    // ---- 建房 ----

    const form = $('create');
    D.BEST_OF.forEach(n => form.bestOf.append(new Option(`BO${n}`, String(n))));
    Object.entries(D.FEARLESS).forEach(([key, mode]) => form.fearless.append(new Option(mode.name, key)));
    form.bestOf.value = '3';
    form.fearless.value = 'global';

    form.addEventListener('submit', async event => {
        event.preventDefault();
        const submit = $('create-button');
        const body = {
            mode: form.mode.value,
            teams: { a: form.teamA.value.trim() || '队伍 A', b: form.teamB.value.trim() || '队伍 B' },
            bestOf: Number(form.bestOf.value),
            fearless: form.fearless.value,
        };
        submit.disabled = true;
        submit.textContent = '创建中…';
        try {
            const response = await fetch('/api/rooms', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || `建房失败（HTTP ${response.status}）`);
            const room = { id: data.id, mode: body.mode, teams: body.teams, bestOf: body.bestOf, fearless: body.fearless, tokens: data.tokens, createdAt: Date.now() };
            saveRecent([room].concat(loadRecent().filter(item => item.id !== room.id)));
            renderRecent();
            showCreated(room);
        } catch (error) {
            toast(location.protocol === 'file:' || error instanceof TypeError ? '连不上联机服务：联机版要在线打开' : error.message);
        } finally {
            submit.disabled = false;
            submit.textContent = '创建房间';
        }
    });

    $('watch').addEventListener('submit', event => {
        event.preventDefault();
        const id = event.target.room.value.trim().toLowerCase();
        if (!/^[a-z0-9]{6}$/.test(id)) return toast('房间号是 6 位字母和数字');
        location.href = roomUrl(id);
    });

    renderRecent();
})();
