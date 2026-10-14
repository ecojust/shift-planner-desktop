import { createApp } from 'vue'
import App from './App.vue'
import { installFocusBehavior } from './focusBehavior'
import './focusBehavior.css'

const disposeFocusBehavior = installFocusBehavior()
if (import.meta.hot) import.meta.hot.dispose(disposeFocusBehavior)
createApp(App).mount('#app')
