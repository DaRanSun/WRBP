// 联机版的服务端：Cloudflare Worker + Durable Objects。
//
//   POST /api/rooms                建房，返回房间号和各身份的口令
//   GET  /api/rooms/<房间号>/ws?k=<口令>   WebSocket；口令决定身份（两队教练、裁判），没有口令就是观战
//   其余路径                        静态页面（dist/，tools/build.js 生成）
//
// 一个房间一个 Durable Object（Room），同一房间的命令排队执行，不会互相打架。
// 每次变化把完整状态推给房间里所有人（按身份附上能做哪些操作）；规则在 room-logic.mjs 和 draft.js。
// 房间 14 天没人动就自动删掉。
import { DurableObject } from 'cloudflare:workers';
import '../data/champions.js';
import { createRoom, apply, snapshot, permissions } from './room-logic.mjs';

const CHAMPIONS = new Map(globalThis.WRBP_DATA.champions.map(c => [c.slug, c.name]));
const CTX = { isChampion: slug => CHAMPIONS.has(slug), name: slug => CHAMPIONS.get(slug) || slug };
const ROOM_TTL_MS = 14 * 24 * 3600 * 1000;
const ROOM_ID = /^[a-z0-9]{6}$/;
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';      // 去掉了容易看错的 i l o 0 1
const MESSAGE_LIMIT = 2000;

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
}

function randomRoomId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
}

function randomToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

export class Room extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.room = null;
        this.tokens = null;
        ctx.blockConcurrencyWhile(async () => {
            this.room = (await ctx.storage.get('room')) || null;
            this.tokens = (await ctx.storage.get('tokens')) || null;
        });
        // 页面每 20 秒发一次 ping 保持连接，由运行时直接回 pong，不唤醒对象。
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }

    // 建房（Worker 通过 RPC 调用）。房间号已被占用时返回 null，让 Worker 换一个。
    async create(options) {
        if (this.room) return null;
        const now = Date.now();
        const room = createRoom(options, now);
        const tokens = { a: randomToken(), b: randomToken() };
        if (room.mode === 'trio') tokens.ref = randomToken();
        this.room = room;
        this.tokens = tokens;
        await this.ctx.storage.put({ room, tokens });
        await this.ctx.storage.setAlarm(now + ROOM_TTL_MS);
        return tokens;
    }

    roleOf(key) {
        if (!key || !this.tokens) return 'view';
        return ['ref', 'a', 'b'].find(role => this.tokens[role] === key) || 'view';
    }

    async fetch(request) {
        if (request.headers.get('Upgrade') !== 'websocket') return new Response('需要 WebSocket 连接', { status: 426 });
        const [client, server] = Object.values(new WebSocketPair());
        if (!this.room) {
            server.accept();
            server.send(JSON.stringify({ type: 'gone' }));
            server.close(4404, 'room not found');
            return new Response(null, { status: 101, webSocket: client });
        }
        const key = new URL(request.url).searchParams.get('k') || '';
        const role = this.roleOf(key);
        this.ctx.acceptWebSocket(server, [role]);
        server.serializeAttachment({ role });
        server.send(JSON.stringify({
            type: 'hello',
            role,
            badKey: !!key && role === 'view',
            tokens: role === 'ref' ? this.tokens : null,     // 只有裁判拿得到所有链接，教练拿不到对面的
        }));
        this.broadcast();
        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, message) {
        if (typeof message !== 'string' || message.length > MESSAGE_LIMIT) return;
        let command;
        try {
            command = JSON.parse(message);
        } catch (error) {
            return;
        }
        if (!this.room) {
            ws.send(JSON.stringify({ type: 'gone' }));
            return;
        }
        const { role } = ws.deserializeAttachment() || { role: 'view' };
        const backup = structuredClone(this.room);
        let changed;
        try {
            changed = apply(this.room, role, command, CTX, Date.now());
        } catch (error) {
            this.room = backup;
            ws.send(JSON.stringify({ type: 'error', message: error.message, id: command && command.id }));
            return;
        }
        if (!changed) return;
        await this.ctx.storage.put('room', this.room);
        await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
        this.broadcast();
    }

    async webSocketClose(ws, code, reason) {
        try { ws.close(code, reason); } catch (error) { /* 已经关了 */ }
        this.broadcast(ws);
    }

    async webSocketError(ws) {
        this.broadcast(ws);
    }

    // 各身份在线几个（同一个链接可以在几台设备上开）。
    presence(exclude) {
        const count = { a: 0, b: 0, ref: 0, view: 0 };
        for (const ws of this.ctx.getWebSockets()) {
            if (ws === exclude) continue;
            const { role } = ws.deserializeAttachment() || {};
            if (role in count) count[role] += 1;
        }
        return count;
    }

    broadcast(exclude) {
        if (!this.room) return;
        const base = { type: 'state', room: snapshot(this.room), presence: this.presence(exclude) };
        const messages = {};
        for (const ws of this.ctx.getWebSockets()) {
            if (ws === exclude) continue;
            const { role } = ws.deserializeAttachment() || { role: 'view' };
            messages[role] = messages[role] || JSON.stringify({ ...base, can: permissions(this.room, role) });
            try { ws.send(messages[role]); } catch (error) { /* 断开的连接由 webSocketClose 处理 */ }
        }
    }

    async alarm() {
        if (this.room && Date.now() - this.room.updatedAt < ROOM_TTL_MS - 60000) {
            await this.ctx.storage.setAlarm(this.room.updatedAt + ROOM_TTL_MS);
            return;
        }
        for (const ws of this.ctx.getWebSockets()) {
            try {
                ws.send(JSON.stringify({ type: 'gone' }));
                ws.close(4404, 'room expired');
            } catch (error) { /* 忽略 */ }
        }
        await this.ctx.storage.deleteAll();
        this.room = null;
        this.tokens = null;
    }
}

async function createRoomRequest(request, env) {
    let body;
    try {
        body = await request.json();
    } catch (error) {
        return json({ error: '请求格式不对' }, 400);
    }
    const options = {
        mode: body.mode,
        teams: { a: body.teams && body.teams.a, b: body.teams && body.teams.b },
        bestOf: Number(body.bestOf),
        fearless: body.fearless,
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const id = randomRoomId();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
        let tokens;
        try {
            tokens = await stub.create({ ...options, id });
        } catch (error) {
            return json({ error: error.message }, 400);
        }
        if (tokens) return json({ id, mode: options.mode, tokens }, 201);
    }
    return json({ error: '房间号分配失败，请重试' }, 503);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === '/api/rooms') {
            if (request.method !== 'POST') return json({ error: '建房请用 POST' }, 405);
            return createRoomRequest(request, env);
        }
        const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
        if (match) {
            if (!ROOM_ID.test(match[1])) return json({ error: '房间号不对' }, 404);
            return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
        }
        if (url.pathname.startsWith('/api/')) return json({ error: '没有这个接口' }, 404);
        return env.ASSETS.fetch(request);
    },
};
