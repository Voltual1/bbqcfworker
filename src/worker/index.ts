// 项目基于优秀开源项目衍生，向原作者致敬
// 项目原作者：ZhuangMS-Theo
// GitHub 仓库：https://github.com/ZhuangMS-Theo/CF-Web-py
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      
      // ==================== ⚡ 1. 万能图片跨域中转（必须放在最前面！） ====================
      if (url.pathname.startsWith('/proxy-img/')) {
        // 提取出真正要请求的第三方图片绝对 URL
        const targetImgUrlStr = url.pathname.slice('/proxy-img/'.length) + url.search;
        
        try {
          const targetImgUrl = new URL(targetImgUrlStr);
          
          // 构造干净的请求头，防止防盗链拦截
          const imgHeaders = new Headers();
          imgHeaders.set('User-Agent', request.headers.get('User-Agent') || 'Mozilla/5.0');
          imgHeaders.set('Host', targetImgUrl.host);
          imgHeaders.set('Referer', targetImgUrl.origin); 
          imgHeaders.set('Accept', 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8');

          // 去第三方源站抓取图片
          const imgResponse = await fetch(targetImgUrl.toString(), {
            method: 'GET',
            headers: imgHeaders,
            redirect: 'follow',
            cf: { cacheEverything: true, cacheTtl: 86400 } // 缓存防刷
          });

          // 核心：强行注入满血版 CORS 和 COEP 头，满足 Wasm 的严格安全标准
          const newImgHeaders = new Headers(imgResponse.headers);
          newImgHeaders.set('Access-Control-Allow-Origin', '*'); 
          newImgHeaders.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
          newImgHeaders.set('Access-Control-Max-Age', '86400');
          
          // 这两行是让 require-corp 页面放行外部资源的致命关键！
          newImgHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');

          return new Response(imgResponse.body, {
            status: imgResponse.status,
            statusText: imgResponse.statusText,
            headers: newImgHeaders
          });
        } catch (e) {
          return new Response(`❌ 代理图片解析失败: ${e.message}`, { status: 400 });
        }
      }

      // ==================== 2. 定义 API 与 上传路由映射表 ====================
      let targetOrigin = null;
      let remainingPath = "";

      if (url.pathname.startsWith('/api/')) {
        targetOrigin = "http://apk.xiaoqu.online";
        remainingPath = url.pathname + url.search;
      } 
      // 修复：兼容 /upload 和 /uploads 两种可能
      else if (url.pathname.startsWith('/upload') || url.pathname.startsWith('/uploads')) {
        targetOrigin = "http://wanyueyun-x.xbjstd.cn:9812";
        remainingPath = url.pathname + url.search;
      }

      // ==================== 3. 分流转发与文本拦截改写 ====================
      if (targetOrigin) {
        const targetUrl = new URL(remainingPath, targetOrigin);

        // 处理 WebSocket
        const upgradeHeader = request.headers.get('Upgrade');
        if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
          return handleWebSocket(request, targetUrl);
        }

        const newHeaders = new Headers(request.headers);
        newHeaders.set('Host', targetUrl.host); 
        newHeaders.set('Referer', targetUrl.origin);
        newHeaders.set('Origin', targetUrl.origin);
        newHeaders.delete('CF-Connecting-IP');
        newHeaders.delete('X-Forwarded-For');
        newHeaders.set('Accept-Encoding', 'gzip, deflate, br');

        const cookieHeader = request.headers.get('Cookie');
        if (cookieHeader) {
          const transformedCookies = transformCookiesForRequest(cookieHeader, targetUrl.hostname);
          if (transformedCookies) {
            newHeaders.set('Cookie', transformedCookies);
          } else {
            newHeaders.delete('Cookie');
          }
        }

        const response = await fetch(targetUrl.toString(), {
          method: request.method,
          headers: newHeaders,
          body: request.body,
          redirect: 'follow', 
          cf: { cacheEverything: false, polish: 'off' }
        });

        const responseHeaders = new Headers(response.headers);
        responseHeaders.delete('Content-Security-Policy');
        responseHeaders.delete('X-Frame-Options');

        responseHeaders.set('Access-Control-Allow-Origin', url.origin);
        responseHeaders.set('Access-Control-Allow-Credentials', 'true');
        responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
        responseHeaders.set('Access-Control-Allow-Headers', '*');

        const setCookieHeaders = response.headers.getAll('Set-Cookie');
        responseHeaders.delete('Set-Cookie');
        for (const setCookie of setCookieHeaders) {
          const transformedCookie = transformSetCookieForResponse(setCookie, url.hostname, targetUrl.hostname);
          if (transformedCookie) {
            responseHeaders.append('Set-Cookie', transformedCookie);
          }
        }

        // 🧬 大杀特杀：全面检查并改写 API 响应中的所有外部图片链接
        const contentType = responseHeaders.get('Content-Type') || '';
        if (contentType.includes('application/json') || contentType.includes('text/')) {
          let text = await response.text();
          
          // 这个正则更激进，匹配所有格式图片链接（即使带复杂 Query 参数）
          const imgRegex = /(https?:\/\/[^\s"'`<>]+?\.(?:png|jpg|jpeg|gif|webp|svg|bmp)(?:\?[^\s"'`<>]*)?)/gi;
          
          // 将匹配到的链接通过动态替换，加上我们自身的代理前缀
          text = text.replace(imgRegex, (match) => {
            // 如果已经是同源请求了，就不动它；非同源的，强行套壳
            if (match.startsWith(url.origin)) return match;
            return `${url.origin}/proxy-img/${match}`;
          });
          
          return new Response(text, { status: response.status, statusText: response.statusText, headers: responseHeaders });
        }

        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
      }

      // ==================== 4. 拦截：网关状态页 ====================
      if (url.pathname === '/gateway-status') {
        return new Response(getGatewayStatusHtml(url), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      // ==================== 5. 兜底：本地 Kotlin Wasm 静态资产 ====================
      const assetResponse = await env.ASSETS.fetch(request); 
      
      const assetHeaders = new Headers(assetResponse.headers);
      assetHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
      assetHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');

      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers: assetHeaders
      });

    } catch (error) {
      return new Response(`❌ 网关路由错误: ${error.message}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  }
};

// ==================== 辅助函数保持不变 ====================
async function handleWebSocket(request, targetUrl) {
  try {
    const wsUrl = new URL(targetUrl.toString());
    wsUrl.protocol = targetUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHeaders = new Headers(request.headers);
    wsHeaders.set('Host', wsUrl.host);
    wsHeaders.set('Origin', wsUrl.origin);
    const targetResponse = await fetch(wsUrl.toString(), { method: 'GET', headers: wsHeaders });
    if (!targetResponse.webSocket) return new Response('目标不支持WebSocket', { status: 400 });
    const targetSocket = targetResponse.webSocket;
    const [clientSocket, serverSocket] = new WebSocketPair();
    targetSocket.accept();
    serverSocket.accept();
    serverSocket.addEventListener('message', (e) => targetSocket.send(e.data));
    targetSocket.addEventListener('message', (e) => serverSocket.send(e.data));
    return new Response(null, { status: 101, webSocket: clientSocket, headers: targetResponse.headers });
  } catch (e) { return new Response(`WebSocket失败: ${e.message}`, { status: 500 }); }
}

function transformCookiesForRequest(cookieHeader, currentHost) {
  const cookies = cookieHeader.split(';').map(c => c.trim());
  const resultCookies = [];
  for (const cookie of cookies) {
    const [name, ...valueParts] = cookie.split('=');
    if (!name) continue;
    const value = valueParts.join('=');
    if (name.startsWith('__py_')) {
      const parts = name.slice(5).split('_');
      if (parts.length < 2) continue;
      if (parts[0] === currentHost || currentHost.endsWith(`.${parts[0]}`)) {
        resultCookies.push(`${parts.slice(1).join('_')}=${value}`);
      }
    }
  }
  return resultCookies.join('; ');
}

function transformSetCookieForResponse(setCookieHeader, pyHost, currentHost) {
  try {
    const parts = setCookieHeader.split(';').map(p => p.trim());
    const [nameValue, ...attributes] = parts;
    const [name, value] = nameValue.split('=');
    if (!name || value === undefined) return null;
    let cookieDomain = null; let cookiePath = '/'; let otherAttributes = [];
    for (const attr of attributes) {
      const [attrName, attrValue] = attr.split('=');
      const lowerAttrName = attrName.toLowerCase();
      if (lowerAttrName === 'domain') cookieDomain = attrValue ? attrValue.replace(/^\./, '') : null;
      else if (lowerAttrName === 'path') cookiePath = attrValue || '/';
      else if (lowerAttrName !== 'samesite' && lowerAttrName !== 'secure') otherAttributes.push(attr);
    }
    const effectiveDomain = cookieDomain || currentHost;
    return [`__py_${effectiveDomain}_${name}=${value}`, `Domain=${pyHost}`, `Path=${cookiePath}`, 'Secure', 'SameSite=Lax', 'HttpOnly', ...otherAttributes].join('; ');
  } catch (e) { return null; }
}

function getGatewayStatusHtml(url) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>网关状态</title></head><body style="font-family:sans-serif; text-align:center; padding-top:10%"><h1>🌐 Cloudflare 多路由分流网关</h1><p>当前分流路由已激活。访问根路径 <code>/</code> 将直接加载 Kotlin Wasm 主程序。</p></body></html>`;
}