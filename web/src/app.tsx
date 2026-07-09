import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "@/components/layout";
import { ProtectedRoute } from "@/components/protected-route";
import Login from "@/pages/login";
import Dashboard from "@/pages/dashboard";
import Providers from "@/pages/providers";
import ImportedModels from "@/pages/providers/imported-models";
import Models from "@/pages/models";
import ApiKeys from "@/pages/api-keys";
import Users from "@/pages/users";
import Usage from "@/pages/usage";
import RequestLogs from "@/pages/request-logs";
import Settings from "@/pages/settings";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/providers" element={<Providers />} />
        <Route
          path="/providers/:id/models"
          element={<ImportedModels />}
        />
        <Route path="/models" element={<Models />} />
        <Route path="/models/new" element={<Models />} />
        <Route path="/models/:id" element={<Models />} />
        <Route path="/keys" element={<ApiKeys />} />
        <Route path="/users" element={<Users />} />
        <Route path="/usage" element={<Usage />} />
        <Route path="/logs" element={<RequestLogs />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
