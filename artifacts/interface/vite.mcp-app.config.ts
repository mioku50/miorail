import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Still's review card for assistants' chats (MCP Apps): one self-contained
// HTML file, scripts and styles inline, because a host loads it from the MCP
// server as a ui:// resource and fetches nothing beside it. The deploy copies
// dist/ to the web root, where the API reads dist/mcp-app/index.html.
export default defineConfig({
  root: 'src/mcp-app',
  // The interface's own .env, so the card carries Still's builder code as the page does.
  envDir: '../..',
  plugins: [react(), viteSingleFile()],
  resolve: {
    // The review controller's default request is the page's API client; the card always passes its own.
    alias: [{ find: /^@mioagent\/api-client-react$/, replacement: fileURLToPath(new URL('./src/mcp-app/apiClientInCard.ts', import.meta.url)) }],
  },
  build: {
    outDir: '../../dist/mcp-app',
    emptyOutDir: true,
  },
})
