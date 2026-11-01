import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App';
import { AuthProvider } from './lib/auth';
import { ToastProvider } from './components/ui';
import { LiveProvider } from './lib/live';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <LiveProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </LiveProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
