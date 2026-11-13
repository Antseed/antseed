import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { captureToken } from './api';
import { App } from './App';
import './styles.scss';

captureToken();
if (!window.location.hash) window.history.replaceState(null, '', '#/stake');

const root = document.getElementById('root');
if (!root) throw new Error('#root element is missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
