import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { YoursWalletProvider } from './components/YoursWalletProvider'
import './styles/app.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <YoursWalletProvider>
      <App />
    </YoursWalletProvider>
  </StrictMode>,
)
