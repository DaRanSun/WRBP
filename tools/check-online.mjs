#!/usr/bin/env node
// 联机端到端自检：真的建房、开几个 WebSocket 客户端（两队教练、裁判、观战）走一遍。
//   node tools/check-online.mjs                         对本地 npm run dev（http://127.0.0.1:8787）
//   node tools/check-online.mjs https://xxx.workers.dev 对线上
// 会建两个测试房间（14 天后自动删除）。
import assert from 'assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../assets/js/draft.js');
require('../data/champions.js');
const D = globalThis.WRBP.draft;
const POOL = globalThis.WRBP_DATA.champions.map(c => c.slug);
const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');

class Client {
    constructor(name, room, token) {
        this.name = name;
        this.messages = [];
        this.waiters = [];
        const url = new URL(`/api/rooms/${room}/ws`, BASE);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        if (token) url.searchParams.set('k', token);
        this.ws = new WebSocket(url);
        this.ws.addEventListener('message', event => {
            if (event.data === 'pong') return;
            const message = JSON.parse(event.data);
            if (message.type === 'state') this.state = message;
            if (message.type === 'hello') this.hello = message;
            this.messages.push(message);
            this.waiters = this.waiters.filter(waiter => !waiter.check(message));
        });
        this.closed = new Promise(resolve => this.ws.addEventListener('close', event => resolve(event)));
    }

    // 等下一条满足条件的消息（已经收到过的不算），超时报错。
    next(test, label) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${this.name} 等不到：${label}`)), 5000);
            this.waiters.push({ check: message => (test(message) ? (clearTimeout(timer), resolve(message), true) : false) });
        });
    }

    state_(test, label) { return this.next(m => m.type === 'state' && test(m), label); }
    error(label) { return this.next(m => m.type === 'error', label); }
    send(command) { this.ws.send(JSON.stringify(command)); }
    // 不等 close 事件：本地开发服务器要等约 10 秒才断 TCP，对面其实 1 毫秒内就收到了离线。
    close() { this.ws.close(); }
}

async function createRoom(mode) {
    const response = await fetch(`${BASE}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, teams: { a: 'TT', b: 'FP' }, bestOf: 3, fearless: 'global' }),
    });
    assert.strictEqual(response.status, 201, `建房 HTTP ${response.status}`);
    return response.json();
}

async function connect(name, room, token) {
    const client = new Client(name, room, token);
    await client.next(m => m.type === 'state', `${name} 的第一份状态`);
    return client;
}

const turnOf = state => D.currentTurn(state.room.series);
const coachOn = (state, turn) => D.teamOn(state.room.series, turn.side);
const free = (state, turn) => POOL.find(slug => !D.blockedReason(state.room.series, turn, slug));

let step = 0;
const ok = label => console.log(`✓ ${++step}. ${label}`);

async function duo() {
    const { id, tokens } = await createRoom('duo');
    assert.ok(/^[a-z0-9]{6}$/.test(id) && tokens.a && tokens.b && !tokens.ref);
    const a = await connect('TT', id, tokens.a);
    const b = await connect('FP', id, tokens.b);
    const view = await connect('观战', id);
    const fake = await connect('假口令', id, 'not-a-token');
    assert.strictEqual(a.hello.role, 'a');
    assert.strictEqual(view.hello.role, 'view');
    assert.ok(fake.hello.badKey && fake.hello.role === 'view');
    assert.strictEqual(a.hello.tokens, null, '教练拿不到别人的口令');
    const presence = view.state.presence;
    assert.deepStrictEqual([presence.a, presence.b, presence.view], [1, 1, 2]);
    ok(`双端建房 ${id}，四个客户端连上，身份和在线人数对`);

    // 预选 → 所有人都看得到；没轮到的一方锁定被拒
    let waiting = view.state_(m => m.room.hover && m.room.hover.slug === 'ahri', '看到预选');
    a.send({ type: 'hover', slug: 'ahri', turn: 0 });
    await waiting;
    b.send({ type: 'lock', slug: 'zed', turn: 0 });
    assert.match((await b.error('没轮到')).message, /还没轮到你/);
    waiting = b.state_(m => m.room.series.game.bans.blue[0] === 'ahri', '蓝 1 禁阿狸');
    a.send({ type: 'lock', turn: 0 });
    await waiting;
    ok('预选广播给所有人，没轮到的锁定被拒，锁定后对面立刻看到');

    // 两队轮流锁满一局
    while (turnOf(a.state)) {
        const turn = turnOf(a.state);
        const coach = coachOn(a.state, turn) === 'a' ? a : b;
        const n = turn.n;
        waiting = a.state_(m => !D.currentTurn(m.room.series) || D.currentTurn(m.room.series).n > n, `第 ${n + 1} 手`);
        coach.send({ type: 'lock', slug: free(a.state, turn), turn: n });
        await waiting;
    }
    assert.ok(D.isComplete(view.state.room.series));
    assert.strictEqual(a.state.can.finish.b, 'direct');
    assert.strictEqual(a.state.can.finish.a, 'propose');
    ok('两队按竞技征召顺序锁满 20 手，记胜负的权限对（认输直接、记自己胜要请求）');

    // 认输直接生效；然后请求撤销，对方同意
    waiting = view.state_(m => m.room.series.score.a === 1, '比分 1:0');
    b.send({ type: 'finish', winner: 'a' });
    await waiting;
    waiting = b.state_(m => m.room.proposal, '收到请求');
    a.send({ type: 'undo' });
    const proposal = (await waiting).room.proposal;
    assert.match(proposal.label, /撤销上一步（第 1 局 TT 胜）/);
    waiting = a.state_(m => m.room.series.score.a === 0 && !m.room.proposal, '撤销生效');
    b.send({ type: 'respond', id: proposal.id, accept: true });
    await waiting;
    ok('认输直接记分；请求撤销要对方同意，同意后比分退回');

    // 断线和重连
    waiting = a.state_(m => m.presence.b === 0, 'FP 离线');
    b.close();
    await waiting;
    const b2 = await connect('FP（重连）', id, tokens.b);
    assert.ok(D.isComplete(b2.state.room.series), '重连拿到的是最新状态');
    assert.strictEqual(b2.state.presence.b, 1);
    ok('断开后对面看到离线，重连拿到最新状态');

    [a, b2, view, fake].forEach(client => client.close());
}

async function trio() {
    const { id, tokens } = await createRoom('trio');
    const ref = await connect('裁判', id, tokens.ref);
    const a = await connect('TT', id, tokens.a);
    assert.strictEqual(ref.hello.role, 'ref');
    assert.deepStrictEqual(Object.keys(ref.hello.tokens).sort(), ['a', 'b', 'ref'], '裁判拿得到所有链接');
    a.send({ type: 'undo' });
    assert.match((await a.error('三端教练不能撤销')).message, /由裁判操作/);
    let waiting = a.state_(m => m.room.series.game.picks.red[2] === 'zed', '裁判改格子');
    ref.send({ type: 'fill', ref: { side: 'red', type: 'pick', index: 2 }, value: 'zed' });
    await waiting;
    waiting = a.state_(m => m.room.series.game.picks.red[2] === null, '裁判撤销');
    ref.send({ type: 'undo' });
    await waiting;
    ok(`三端房间 ${id}：教练不能撤销，裁判能改任意一格、直接撤销`);
    [ref, a].forEach(client => client.close());

    const missing = new Client('不存在的房间', 'zzzzzz');
    await missing.next(m => m.type === 'gone', '房间不存在');
    const closed = await missing.closed;
    assert.strictEqual(closed.code, 4404);
    ok('不存在的房间：收到 gone 并关闭（4404）');
}

const started = Date.now();
await duo();
await trio();
console.log(`全部通过（${BASE}，${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
process.exit(0);
