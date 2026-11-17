import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './query-client.js';
import { AuthProvider } from './auth.jsx';
import { App } from './App.jsx';
import { OfflineProvider } from './offline/provider.jsx';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider><OfflineProvider><App /></OfflineProvider></AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
