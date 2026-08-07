export type Role = "admin" | "manager" | "employee";

interface Credentials {
  email: string;
  password: string;
}

export const USERS: Record<Role, Credentials> = {
  admin: {
    email: process.env.LMS_ADMIN_EMAIL ?? "balajim@incubxperts.com",
    password: process.env.LMS_ADMIN_PASSWORD ?? "Passw0rd!",
  },
  manager: {
    email: process.env.LMS_MANAGER_EMAIL ?? "nora.fenwick@example.com",
    password: process.env.LMS_MANAGER_PASSWORD ?? "Passw0rd!",
  },
  employee: {
    email: process.env.LMS_EMPLOYEE_EMAIL ?? "devon.marsh@example.com",
    password: process.env.LMS_EMPLOYEE_PASSWORD ?? "Passw0rd!",
  },
};
