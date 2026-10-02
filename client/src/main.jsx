import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import { Layout, Spinner } from './components.jsx';
import AuthPage from './pages/Auth.jsx';
import Groups from './pages/Groups.jsx';
import Group from './pages/Group.jsx';
import Join from './pages/Join.jsx';
import './styles.css';

// Logged-in pages. Visitors are sent to /login and brought back afterwards (for invite links).
function Protected({ children }) {
  const { user, loading } = useAuth();
  const { pathname } = useLocation();
  if (loading) return <Spinner full />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(pathname)}`} replace />;
  return <Layout>{children}</Layout>;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/register" element={<AuthPage mode="register" />} />
          <Route path="/groups" element={<Protected><Groups /></Protected>} />
          <Route path="/groups/:id" element={<Protected><Group /></Protected>} />
          <Route path="/join/:token" element={<Protected><Join /></Protected>} />
          <Route path="*" element={<Navigate to="/groups" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
