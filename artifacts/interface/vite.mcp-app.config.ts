import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Still's review card for assistants' chats (MCP Apps): one self-contained
// HTML file, scripts and styles inline, because a host loads it from the MCP
// server as a ui:// resource and fetches nothing beside it. The deploy copies
// dist/ to the web root, where the API reads dist/mcp-app/index.html.
export default defineConfig({
  root: 'src/mcp-app',
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: '../../dist/mcp-app',
    emptyOutDir: true,
  },
})
