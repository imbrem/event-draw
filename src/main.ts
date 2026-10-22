import './style.css';
import './ui/writing-workspace.css';
import { startApp } from './app.ts';

const close = startApp();
if (import.meta.hot) import.meta.hot.dispose(close);
