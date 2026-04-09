'use strict';

const http = require('node:http');
const WebSocket = require('ws');
const { EventEmitter } = require('node:events');

class Inspector extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 9229 } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.ws = null;
    this._id = 0;
    this._callbacks = new Map();
  }

  /**
   * Discover the inspector WebSocket URL via /json/list
   */
  async getWebSocketUrl() {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://${this.host}:${this.port}/json/list`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const targets = JSON.parse(data);
            if (targets.length === 0) {
              return reject(new Error('No inspector targets found'));
            }
            resolve(targets[0].webSocketDebuggerUrl);
          } catch (e) {
            reject(new Error(`Failed to parse inspector response: ${e.message}`));
          }
        });
      });
      req.on('error', (err) => {
        reject(new Error(
          `Cannot connect to inspector at ${this.host}:${this.port}. ` +
          `Is the Node.js inspector active? (${err.message})`
        ));
      });
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Timeout connecting to inspector'));
      });
    });
  }

  /**
   * Connect to the inspector WebSocket
   */
  async connect() {
    const wsUrl = await this.getWebSocketUrl();

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id !== undefined && this._callbacks.has(msg.id)) {
          const { resolve, reject, timer } = this._callbacks.get(msg.id);
          clearTimeout(timer);
          this._callbacks.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message));
          } else {
            resolve(msg.result);
          }
        } else if (msg.method) {
          this.emit('event', msg);
        }
      });

      this.ws.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this.ws.on('close', () => {
        // Reject all pending callbacks — target is gone
        for (const { reject, timer } of this._callbacks.values()) {
          clearTimeout(timer);
          try { reject(new Error('Target process exited')); } catch {}
        }
        this._callbacks.clear();
        this.emit('disconnected');
      });
    });
  }

  /**
   * Send a CDP command and wait for the response
   */
  async send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Inspector not connected');
    }

    const id = ++this._id;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._callbacks.has(id)) {
          this._callbacks.delete(id);
          reject(new Error(`CDP command timeout: ${method}`));
        }
      }, 30000);

      this._callbacks.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Disconnect from the inspector
   */
  async disconnect() {
    if (this.ws) {
      // Clear all pending timeouts and reject pending callbacks
      for (const { reject, timer } of this._callbacks.values()) {
        clearTimeout(timer);
        try { reject(new Error('Inspector disconnected')); } catch {}
      }
      this._callbacks.clear();
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = { Inspector };
