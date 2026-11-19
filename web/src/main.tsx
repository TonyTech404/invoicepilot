import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import './styles.css';
import { Layout } from './App';
import { InboxPage } from './pages/InboxPage';
import { InvoicePage } from './pages/InvoicePage';
import { SyncPage } from './pages/SyncPage';
import { ReconcilePage } from './pages/ReconcilePage';
import { HowItWorksPage } from './pages/HowItWorksPage';

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <InboxPage /> },
      { path: '/invoices/:id', element: <InvoicePage /> },
      { path: '/sync', element: <SyncPage /> },
      { path: '/reconcile', element: <ReconcilePage /> },
      { path: '/how-it-works', element: <HowItWorksPage /> },
      { path: '*', element: <p className="py-20 text-center text-ink-soft">That page does not exist. <a className="underline" href="/">Go to invoices</a></p> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
