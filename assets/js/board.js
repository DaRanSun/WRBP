// 棋盘：两侧的禁用位和选用位、BP 流程条、英雄池（检索、排序）、系列赛记录。单机（app.js）和联机（room.js）共用。
// 棋盘自己不保存 BP 状态：每次 render 传进当前状态和“下一个英雄会填进哪一格”，点击交给调用方处理。
(function () {
    'use strict';

    const D = WRBP.draft;
    const C = WRBP.champions;
    const PREFS_KEY = 'wrbp:prefs';
    const FINE_POINTER = window.matchMedia('(pointer: fine)').matches;

    const $ = id => document.getElementById(id);
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }
    function button(text, className, onClick) {
        const node = el('button', className, text);
        node.type = 'button';
        if (onClick) node.addEventListener('click', onClick);
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

    function copyText(text, done) {
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
            toast(ok ? done : '复制失败，浏览器不允许访问剪贴板');
        };
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => toast(done), fallback);
        else fallback();
    }

    function isTextField(node) {
        if (!node) return false;
        if (node.isContentEditable || node.tagName === 'TEXTAREA') return true;
        return node.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'range'].includes(node.type);
    }

    const sameRef = (a, b) => !!a && !!b && a.side === b.side && a.type === b.type && a.index === b.index;
    const refOf = turn => ({ side: turn.side, type: turn.type, index: turn.index });
    const slotLabel = ref => (ref.type === 'ban' ? `禁用 ${ref.index + 1}` : `${ref.index + 1} 楼`);
    const valueName = value => (value === null ? '空' : value === D.EMPTY_BAN ? '空 Ban' : C.name(value));

    function loadPrefs() {
        try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (error) { return {}; }
    }

    // options：
    //   onSlot(ref)            点了一格（view.slots === false 时格子不可点）
    //   onTile(slug, searched) 点了英雄池里的英雄；searched = 是不是搜索后点的
    //   onEnter(slug)          搜索框回车；slug 是第一个能选的（可能为 null）
    //   onEscape()             搜索框是空的时候按 Esc
    //   onRename(team, name)   改队名
    //   rulesHint              页脚规则说明后面加的一句操作提示
    function create(options) {
        const ui = { query: '', sort: loadPrefs().sort === 'usage' ? 'usage' : 'name' };
        let view = null;
        let nextSlug = null;

        // ---- 两侧：骨架只建一次（队名输入框在打字时不会被重建） ----
        const sides = {};
        D.SIDES.forEach(side => {
            const root = $(`side-${side}`);
            const head = el('div', 'side-head');
            const tag = el('span', 'side-tag', D.SIDE_NAMES[side]);
            const you = el('span', 'side-you', '你');
            you.hidden = true;
            const name = el('input', 'team-name');
            name.maxLength = 16;
            name.setAttribute('aria-label', `${D.SIDE_NAMES[side]}队名`);
            name.addEventListener('change', () => {
                if (!view) return;
                const team = D.teamOn(view.state, side);
                options.onRename(team, name.value.trim() || (team === 'a' ? '队伍 A' : '队伍 B'));
            });
            name.addEventListener('keydown', event => { if (event.key === 'Enter') name.blur(); });
            const score = el('span', 'side-score');
            score.title = '系列赛比分';
            head.append(tag, you, name, score);

            // 禁用位按轮分组：第一轮 3 个、第二轮 2 个。
            const bans = el('div', 'bans');
            const banSlots = [];
            let group = null;
            let phase = null;
            D.TURNS.filter(t => t.side === side && t.type === 'ban').forEach(turn => {
                if (turn.phase !== phase) {
                    group = el('div', 'ban-group');
                    bans.append(group);
                    phase = turn.phase;
                }
                const slot = button('', 'ban-slot', () => clickSlot(refOf(turn)));
                group.append(slot);
                banSlots[turn.index] = slot;
            });

            const picks = el('div', 'picks');
            const pickSlots = [];
            for (let index = 0; index < D.SLOT_COUNT.pick; index += 1) {
                const slot = button('', 'pick-slot', () => clickSlot({ side, type: 'pick', index }));
                picks.append(slot);
                pickSlots.push(slot);
            }

            const used = el('div', 'side-used');
            root.append(head, el('div', 'side-label', '禁用'), bans, el('div', 'side-label', '选用'), picks, used);
            sides[side] = { root, name, you, score, banSlots, pickSlots, used };
        });

        function clickSlot(ref) {
            if (view && view.slots !== false) options.onSlot(ref);
        }

        // 一格的内容：已填的英雄、空 Ban、空格；空格正好是预选的那一格时，半透明显示预选的英雄。
        function paintSlot(node, ref, value, hover, active, editing) {
            const preview = value === null && hover ? hover : null;
            node.classList.toggle('is-filled', value !== null);
            node.classList.toggle('is-none', value === D.EMPTY_BAN);
            node.classList.toggle('is-hover', !!preview);
            node.classList.toggle('is-active', active);
            node.classList.toggle('is-editing', editing);
            node.classList.toggle('is-static', view.slots === false);
            node.title = `${D.SIDE_NAMES[ref.side]}${slotLabel(ref)}：${preview ? `预选 ${C.name(preview)}` : valueName(value)}`
                + (view.slots === false ? '' : '（点一下修改这一格）');
            const key = `${value}|${preview}`;
            if (node.dataset.value === key) return;              // 内容没变就不重建图片，免得闪
            node.dataset.value = key;
            node.replaceChildren();
            const shown = value || preview;
            if (ref.type === 'ban') {
                if (shown) node.append(C.icon(shown));
                else node.append(el('span', 'ban-mark', value === D.EMPTY_BAN ? '⊘' : String(ref.index + 1)));
            } else {
                if (shown) node.append(C.portrait(shown));
                else node.append(el('span', 'pick-ghost', String(ref.index + 1)));
                node.append(el('span', 'pick-order', preview ? `${slotLabel(ref)} · 预选` : slotLabel(ref)),
                    el('span', 'pick-name', shown ? C.name(shown) : ''));
            }
        }

        function hoverAt(ref) {
            return view.hover && sameRef(view.hover.ref, ref) ? view.hover.slug : null;
        }

        function renderSides() {
            const state = view.state;
            D.SIDES.forEach(side => {
                const box = sides[side];
                const team = D.teamOn(state, side);
                if (document.activeElement !== box.name) box.name.value = state.teams[team].name;
                box.name.readOnly = !(view.canRename && view.canRename(team));
                box.you.hidden = view.you !== team;
                box.root.classList.toggle('is-you', view.you === team);
                box.score.textContent = state.score[team];
                const paint = (slots, type) => slots.forEach((node, index) => {
                    const ref = { side, type, index };
                    paintSlot(node, ref, D.getSlot(state, ref), hoverAt(ref), sameRef(view.active, ref), sameRef(view.target, ref));
                });
                paint(box.banSlots, 'ban');
                paint(box.pickSlots, 'pick');

                // 全局 BP：这支队伍之前几局选过的英雄。
                box.used.replaceChildren();
                const previous = state.games.flatMap(game => game.picks[game.blue === team ? 'blue' : 'red']).filter(Boolean);
                box.used.hidden = state.fearless === 'off' || !previous.length;
                if (!box.used.hidden) {
                    box.used.append(el('div', 'side-label', `之前已用 · ${previous.length}`));
                    const list = el('div', 'used-list');
                    previous.forEach(slug => {
                        const item = el('span', 'mini');
                        item.title = C.name(slug);
                        item.append(C.icon(slug));
                        list.append(item);
                    });
                    box.used.append(list);
                }
            });
        }

        // ---- BP 流程条 ----
        function renderSequence() {
            const list = $('sequence');
            list.replaceChildren();
            D.FORMAT.phases.forEach(phase => {
                const group = el('li', 'seq-group');
                const items = el('div', 'seq-items');
                group.append(el('span', 'seq-title', phase.name), items);
                D.TURNS.filter(t => t.phase === phase.key).forEach(turn => {
                    const value = D.getSlot(view.state, turn);
                    const preview = value === null ? hoverAt(turn) : null;
                    const chip = button('', 'seq', () => clickSlot(refOf(turn)));
                    chip.classList.toggle('is-static', view.slots === false);
                    chip.dataset.side = turn.side;
                    chip.dataset.type = turn.type;
                    chip.classList.toggle('is-filled', value !== null);
                    chip.classList.toggle('is-hover', !!preview);
                    chip.classList.toggle('is-active', sameRef(view.active, turn));
                    chip.classList.toggle('is-editing', sameRef(view.target, turn));
                    chip.title = `${turn.n + 1}. ${D.SIDE_NAMES[turn.side]}${slotLabel(turn)}：${preview ? `预选 ${C.name(preview)}` : valueName(value)}`;
                    if (value || preview) chip.append(C.icon(value || preview));
                    else chip.append(el('span', 'seq-mark', value === D.EMPTY_BAN ? '⊘' : turn.type === 'ban' ? '禁' : '选'));
                    items.append(chip);
                });
                list.append(group);
            });
        }

        // ---- 英雄池 ----
        const grid = $('grid');
        const tiles = new Map();

        function tileFor(champion) {
            let tile = tiles.get(champion.slug);
            if (!tile) {
                tile = button('', 'tile');
                tile.dataset.slug = champion.slug;
                const art = el('span', 'tile-art');
                art.append(C.icon(champion.slug, true), el('span', 'tile-badge'));
                tile.append(art, el('span', 'tile-name', champion.name));
                tiles.set(champion.slug, tile);
            }
            return tile;
        }

        function renderGrid() {
            if (!view) return;
            const state = view.state;
            const ref = view.active;
            const source = ui.sort === 'usage' ? C.byUsage : C.list;
            const results = C.search(ui.query, source);
            const used = D.usedThisGame(state, ref || undefined);
            const fearless = D.fearlessBlocked(state);
            const current = ref ? D.getSlot(state, ref) : null;
            const hover = view.hover ? view.hover.slug : null;
            nextSlug = null;

            results.forEach(champion => {
                const slug = champion.slug;
                const tile = tileFor(champion);
                let badge = '';
                let kind = '';
                let reason = ref ? D.blockedReason(state, ref, slug) : null;
                if (used[slug]) {
                    badge = used[slug].kind === 'ban' ? '禁' : used[slug].side === 'blue' ? '蓝' : '红';
                    kind = used[slug].kind === 'ban' ? 'ban' : used[slug].side;
                    reason = reason || used[slug].reason;
                } else {
                    // 没有正在填的格子时，只把双方都被锁住的英雄标出来。
                    const lock = ref ? reason && fearless.sides[ref.side][slug] : fearless.sides.blue[slug] && fearless.sides.red[slug];
                    if (lock) {
                        badge = `G${lock.game}`;
                        kind = 'fearless';
                        reason = reason || lock.reason;
                    }
                }
                const blocked = !!(ref ? reason : badge);
                tile.classList.toggle('is-blocked', blocked);
                tile.classList.toggle('is-current', !!current && current === slug);
                tile.classList.toggle('is-hover', hover === slug);
                tile.querySelector('.tile-badge').textContent = badge;
                tile.dataset.badge = kind;
                tile.title = C.describe(slug) + (reason ? `\n✕ ${reason}` : '');
                if (!nextSlug && ui.query && ref && !blocked && current !== slug) nextSlug = slug;
            });
            results.forEach(champion => {
                const tile = tileFor(champion);
                const next = !!view.enter && champion.slug === nextSlug;
                tile.classList.toggle('is-next', next);
                if (next) tile.dataset.enter = view.enter;
            });

            // 顺序没变就不动 DOM：整体重排会让手机上的页面跳回上面。
            const order = results.map(tileFor);
            const children = grid.children;
            if (order.length !== children.length || order.some((tile, i) => children[i] !== tile)) grid.replaceChildren(...order);
            $('no-result').hidden = results.length > 0;
            $('search-count').textContent = ui.query ? `${results.length} 个` : `${C.list.length} 名英雄`;
            $('search-count').classList.toggle('is-idle', !ui.query);
            document.querySelectorAll('.sort button').forEach(node => node.classList.toggle('is-on', node.dataset.sort === ui.sort));
        }

        grid.addEventListener('click', event => {
            const tile = event.target.closest('.tile');
            if (tile) options.onTile(tile.dataset.slug, !!ui.query);
        });

        function shake(slug) {
            const tile = tiles.get(slug);
            if (!tile) return;
            tile.classList.remove('is-shake');
            void tile.offsetWidth;
            tile.classList.add('is-shake');
        }

        // ---- 系列赛记录 ----
        function miniList(slugs, className) {
            const list = el('div', className);
            slugs.forEach(slug => {
                const item = el('span', 'mini');
                if (slug) {
                    item.title = C.name(slug);
                    item.append(C.icon(slug));
                } else {
                    item.classList.add('is-none');
                    item.title = slug === D.EMPTY_BAN ? '空 Ban' : '空';
                    item.textContent = slug === D.EMPTY_BAN ? '⊘' : '';
                }
                list.append(item);
            });
            return list;
        }

        function renderHistory() {
            const state = view.state;
            const teamName = team => state.teams[team].name;
            const box = $('history');
            box.replaceChildren();
            const head = el('div', 'history-head');
            head.append(el('h2', '', '系列赛记录'),
                el('span', 'history-score', `${teamName('a')} ${state.score.a} : ${state.score.b} ${teamName('b')}`));
            const locked = new Set(state.games.flatMap(game => game.picks.blue.concat(game.picks.red)).filter(Boolean));
            if (state.fearless !== 'off' && locked.size) head.append(el('span', 'history-note', `全局 BP 已用 ${locked.size} 名英雄`));
            head.append(button('复制文字记录', 'history-copy', () => copyText(recordText(state), '已复制文字记录')));
            box.append(head);

            if (!state.games.length) {
                box.append(el('p', 'history-empty', 'BP 完成后记下胜方，这一局就会记在这里。开启全局 BP 时，之前选过的英雄在英雄池里会变灰并标出是第几局用的。'));
                return;
            }
            const games = el('div', 'games');
            state.games.forEach(game => {
                const card = el('article', 'game-card');
                const title = el('header', 'game-title');
                title.append(el('strong', '', `第 ${game.n} 局`), el('span', '', `${teamName(game.winner)} 胜`));
                card.append(title);
                D.SIDES.forEach(side => {
                    const team = D.teamOn(state, side, game);
                    const row = el('div', 'game-row');
                    row.dataset.side = side;
                    const who = el('div', 'row-team');
                    who.append(el('span', 'row-side', D.SIDE_NAMES[side]), el('span', 'row-name', teamName(team)));
                    if (game.winner === team) who.append(el('span', 'row-win', '胜'));
                    const lists = el('div', 'row-lists');
                    lists.append(miniList(game.picks[side], 'row-picks'), miniList(game.bans[side], 'row-bans'));
                    row.append(who, lists);
                    card.append(row);
                });
                games.append(card);
            });
            box.append(games);
        }

        // ---- 搜索、排序、键盘 ----
        const search = $('search');
        // 手机上搜索框窄，提示写短一些。
        const narrow = window.matchMedia('(max-width: 640px)');
        search.dataset.placeholder = search.placeholder;
        const placeholder = () => { search.placeholder = narrow.matches ? '搜英雄：名字 / 昵称 / 拼音' : search.dataset.placeholder; };
        placeholder();
        narrow.addEventListener('change', placeholder);
        search.addEventListener('input', () => {
            ui.query = search.value;
            renderGrid();
        });
        search.addEventListener('keydown', event => {
            if (event.isComposing || event.keyCode === 229) return;      // 输入法还在组字
            if (event.key === 'Enter') {
                event.preventDefault();
                options.onEnter(ui.query.trim() ? nextSlug : null, !!ui.query.trim());
            } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                if (ui.query) { clearSearch(); renderGrid(); } else if (options.onEscape) options.onEscape();
            }
        });

        document.querySelectorAll('.sort button').forEach(node => node.addEventListener('click', () => {
            ui.sort = node.dataset.sort;
            try { localStorage.setItem(PREFS_KEY, JSON.stringify({ sort: ui.sort })); } catch (error) { /* 记不住也没关系 */ }
            renderGrid();
        }));

        // 不在输入框时直接打字就进搜索框，“/” 也能聚焦。
        document.addEventListener('keydown', event => {
            if (isTextField(event.target) || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
            if (event.key === '/') {
                event.preventDefault();
                search.focus();
            } else if (event.key.length === 1 && event.key !== ' ' && event.target.tagName !== 'SELECT') {
                search.focus();
            }
        });

        function clearSearch() {
            search.value = '';
            ui.query = '';
        }

        function focusSearch() {
            if (FINE_POINTER) search.focus({ preventScroll: true });
        }

        // ---- 页脚 ----
        const sideMarks = order => order.trim().split(/\s+/).reduce((groups, mark) => {
            const last = groups[groups.length - 1];
            if (last && last[0] === mark) groups[groups.length - 1] += mark;
            else groups.push(mark);
            return groups;
        }, []).map(group => group.replace(/B/g, '蓝').replace(/R/g, '红')).join(' ');
        $('rules').textContent = `${D.FORMAT.name}：${D.FORMAT.phases.map(p => `${p.name} ${sideMarks(p.order)}`).join(' → ')}。`
            + '双方各禁 5、选 5，不计时；同一局禁用或选用过的英雄双方都不能再用，禁用位可以空 Ban。'
            + (options.rulesHint || '');
        $('source').textContent = `英雄池：WRPedia V${C.source.version || '?'}，${C.list.length} 名英雄（同步于 ${C.source.syncedAt || '?'}）。规则：WROB 赛事征召。`;

        // view：
        //   state     系列赛状态（draft.js）
        //   active    下一个英雄会填进哪一格（null = 现在没有）
        //   target    正在改的那一格（金色框），null = 按流程走
        //   hover     { ref, slug }：这一格的预选，半透明显示
        //   you       联机时自己是哪支队伍（'a' / 'b'），那一侧标“你”
        //   slots     false = 格子只能看不能点（联机的教练、观战）
        //   canRename(team)  能不能改这支队伍的名字
        //   enter     搜索后回车会做什么（显示在高亮英雄上，例如“回车”“回车预选”；空 = 回车不起作用）
        function render(next) {
            view = next;
            document.body.dataset.turn = view.active ? view.active.side : '';
            document.body.classList.toggle('is-editing', !!view.target);
            renderSides();
            renderSequence();
            renderGrid();
            renderHistory();
        }

        return {
            render,
            clearSearch,
            focusSearch,
            shake,
            get query() { return ui.query; },
        };
    }

    // 系列赛的文字记录（复制给别人看）。
    function recordText(state) {
        const teamName = team => state.teams[team].name;
        const names = list => list.map(slug => (slug === null ? '—' : valueName(slug))).join('、');
        const lines = [`${teamName('a')} ${state.score.a} : ${state.score.b} ${teamName('b')}（BO${state.bestOf} · ${D.FEARLESS[state.fearless].name}）`];
        const describe = (title, game) => {
            lines.push('', title);
            D.SIDES.forEach(side => {
                const team = D.teamOn(state, side, game);
                lines.push(`${D.SIDE_NAMES[side]} ${teamName(team)}${game.winner === team ? '（胜）' : ''}`);
                lines.push(`  选用：${names(game.picks[side])}`);
                lines.push(`  禁用：${names(game.bans[side])}`);
            });
        };
        state.games.forEach(game => describe(`第 ${game.n} 局`, game));
        if (!D.decided(state) && !D.isEmpty(state)) describe(`第 ${state.games.length + 1} 局（${D.isComplete(state) ? 'BP 完成' : 'BP 进行中'}）`, state.game);
        return lines.join('\n');
    }

    WRBP.board = { create, recordText };
    WRBP.ui = { $, el, button, toast, copyText, isTextField, sameRef, refOf, slotLabel, valueName };
})();
