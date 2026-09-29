import { isPathEnabled, type ServiceCode } from "./services";

/**
 * Workspace shell navigation (build sheet §12), built only from what the
 * server resolved for this user in this workspace: effective permissions
 * (already reduced to enabled services by the database) and enabled services.
 */
export type WorkspaceNavItem = { href: string; label: string; external?: boolean };
export type WorkspaceNavGroup = { name: string; items: WorkspaceNavItem[] };

type Candidate = WorkspaceNavItem & { permission?: string; services?: readonly ServiceCode[]; operational?: boolean };

/** Where the Hanafy CRM console (campaigns, SMS, automations) lives today. */
export const HANAFY_CRM_CONSOLE_URL = "https://hanafymedia.com/admin/sms";

const groups: ReadonlyArray<{ name: string; items: Candidate[] }> = [
  {
    name: "POS",
    items: [
      { href: "/pos", label: "Register", permission: "pos.access", operational: true },
      { href: "/kitchen", label: "Kitchen", permission: "kitchen.access", operational: true },
      { href: "/admin/orders", label: "Orders", permission: "orders.view", operational: true },
      { href: "/admin/delivery", label: "Delivery", permission: "delivery.dispatch", operational: true },
      { href: "/driver", label: "Driver", permission: "driver.access", operational: true },
      { href: "/admin/cash", label: "Cash", permission: "cash.manage", operational: true },
      { href: "/admin/payments", label: "Payments", permission: "payments.manage", operational: true },
    ],
  },
  {
    name: "Customers",
    items: [
      { href: "/admin/customers", label: "Customer list", permission: "customers.view", operational: true },
      { href: "/admin/segments", label: "Segments", permission: "segments.manage", operational: true },
    ],
  },
  {
    name: "Marketing",
    items: [
      { href: "/admin/promotions", label: "Promotions", permission: "promotions.manage", operational: true },
      { href: "/admin/marketing", label: "Campaigns", permission: "campaigns.view", operational: true },
      { href: HANAFY_CRM_CONSOLE_URL, label: "Hanafy CRM console", external: true, permission: "admin.access", services: ["sms", "automations", "email"] },
    ],
  },
  {
    name: "Analytics",
    items: [{ href: "/admin/reports", label: "Sales & reports", permission: "reports.view", operational: true }],
  },
  {
    name: "Setup",
    items: [
      { href: "/admin/menu", label: "Menu", permission: "menu.manage", operational: true },
      { href: "/admin/settings", label: "Website & hours", permission: "content.manage", operational: true },
      { href: "/admin/printing", label: "Printing", permission: "printing.manage", operational: true },
      { href: "/admin/hardware", label: "Devices", permission: "hardware.manage", operational: true },
      { href: "/admin/staff", label: "Employees", permission: "staff.view", operational: true },
      { href: "/admin/integrations", label: "Integrations", permission: "integrations.manage", operational: true },
      { href: "/admin/audit", label: "Audit log", permission: "audit.view", operational: true },
    ],
  },
];

export type NavigationInput = {
  permissions: readonly string[];
  enabledServices: readonly string[];
  /** The operational screens run on pre-platform functions for one workspace only. */
  legacyOperations: boolean;
};

export function buildWorkspaceNavigation(input: NavigationInput): WorkspaceNavGroup[] {
  return groups
    .map((group) => ({
      name: group.name,
      items: group.items
        .filter((item) => !item.operational || input.legacyOperations)
        .filter((item) => !item.permission || input.permissions.includes(item.permission))
        .filter((item) => (item.services ? item.services.some((service) => input.enabledServices.includes(service)) : true))
        .filter((item) => item.external || isPathEnabled(item.href, input.enabledServices))
        .map(({ href, label, external }) => ({ href, label, ...(external ? { external } : {}) })),
    }))
    .filter((group) => group.items.length > 0);
}
