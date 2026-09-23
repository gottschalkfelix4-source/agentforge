import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AuthGate, PublicOnly } from '@/features/auth/AuthGate';
import { LoginPage } from '@/features/auth/LoginPage';
import { SetupPage } from '@/features/auth/SetupPage';
import { AppShell } from '@/features/projects/AppShell';
import { HomePage } from '@/features/projects/HomePage';
import { ProjectView } from '@/features/projects/ProjectView';
import { SettingsPage } from '@/features/settings/SettingsPage';

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/setup"
          element={
            <PublicOnly mode="setup">
              <SetupPage />
            </PublicOnly>
          }
        />
        <Route
          path="/login"
          element={
            <PublicOnly mode="login">
              <LoginPage />
            </PublicOnly>
          }
        />
        <Route
          element={
            <AuthGate>
              <AppShell />
            </AuthGate>
          }
        >
          <Route index element={<HomePage />} />
          <Route path="p/:projectId" element={<ProjectView />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="settings/:tab" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
