import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import MdPreviewWindow from './components/MdPreviewWindow.vue'
import './styles/main.css'

// 独立 md 预览窗口（主进程 md-preview:open 加载 index.html?view=md&path=...）：
// 挂载最小预览根组件，绕过登录遮罩、侧边栏与聊天区，直接全页渲染 md
const params = new URLSearchParams(window.location.search)
const rootComponent = params.get('view') === 'md' ? MdPreviewWindow : App

const app = createApp(rootComponent)
app.use(createPinia())
app.mount('#app')
