import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
	plugins: [
		cloudflare() // 只保留 Cloudflare 插件来处理 Worker
	],
	build: {
		// 告诉 Vite 我们不需要打包标准的浏览器端 html 入口
		ssr: true, 
		rollupOptions: {
			input: "./src/worker/index.ts" // 明确指定 Worker 为入口
		}
	}
});