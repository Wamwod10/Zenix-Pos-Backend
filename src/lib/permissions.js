export const ROLES = Object.freeze({
  OWNER:"OWNER",
  ADMIN:"ADMIN",
  MANAGER:"MANAGER",
  CASHIER:"CASHIER",
  SALES:"SALES",
  WAREHOUSE:"WAREHOUSE",
  PLATFORM_ADMIN:"PLATFORM_ADMIN",
});

// Keep these keys identical to the frontend permission contract. The backend is
// authoritative; frontend checks are only for UX/navigation.
export const DEFAULT_ROLE_PERMISSIONS = Object.freeze({
  OWNER: { "*":true },
  ADMIN: {
    moduleDashboard:true,moduleShifts:true,moduleSales:true,moduleHistory:true,moduleProducts:true,moduleInventory:true,moduleSuppliers:true,moduleExpenses:true,moduleAnalytics:true,moduleSellerAnalytics:true,moduleActivityLog:true,moduleSettings:true,moduleBilling:true,
    productWrite:true,inventoryAdjust:true,transferView:true,transferCreate:true,transferApprove:true,transferReceive:true,transferCancel:true,supplierWrite:true,returns:true,expensesWrite:true,analytics:true,shiftRecon:true,billingWrite:false,inventoryCountApprove:true,closeBusinessDay:true,dataExport:true,settingsWrite:true,
  },
  MANAGER: {
    moduleDashboard:true,moduleShifts:true,moduleSales:true,moduleHistory:true,moduleProducts:true,moduleInventory:true,moduleSuppliers:true,moduleExpenses:true,moduleAnalytics:true,moduleSellerAnalytics:true,moduleActivityLog:true,moduleSettings:false,moduleBilling:false,
    productWrite:true,inventoryAdjust:true,transferView:true,transferCreate:true,transferApprove:false,transferReceive:true,transferCancel:true,supplierWrite:true,returns:true,expensesWrite:true,analytics:true,shiftRecon:true,billingWrite:false,inventoryCountApprove:false,closeBusinessDay:false,dataExport:false,settingsWrite:false,
  },
  CASHIER: {
    moduleDashboard:false,moduleShifts:true,moduleSales:true,moduleHistory:true,moduleProducts:false,moduleInventory:false,moduleSuppliers:false,moduleExpenses:false,moduleAnalytics:false,moduleSellerAnalytics:false,moduleActivityLog:false,moduleSettings:false,moduleBilling:false,
    productWrite:false,inventoryAdjust:false,transferView:false,transferCreate:false,transferApprove:false,transferReceive:false,transferCancel:false,supplierWrite:false,returns:true,expensesWrite:false,analytics:false,shiftRecon:false,billingWrite:false,inventoryCountApprove:false,closeBusinessDay:false,dataExport:false,settingsWrite:false,
  },
  SALES: {
    moduleDashboard:false,moduleShifts:true,moduleSales:true,moduleHistory:true,moduleProducts:true,moduleInventory:false,moduleSuppliers:false,moduleExpenses:false,moduleAnalytics:false,moduleSellerAnalytics:false,moduleActivityLog:false,moduleSettings:false,moduleBilling:false,
    productWrite:false,inventoryAdjust:false,transferView:false,transferCreate:false,transferApprove:false,transferReceive:false,transferCancel:false,supplierWrite:false,returns:false,expensesWrite:false,analytics:false,shiftRecon:false,billingWrite:false,inventoryCountApprove:false,closeBusinessDay:false,dataExport:false,settingsWrite:false,
  },
  WAREHOUSE: {
    moduleDashboard:false,moduleShifts:false,moduleSales:false,moduleHistory:false,moduleProducts:true,moduleInventory:true,moduleSuppliers:true,moduleExpenses:false,moduleAnalytics:false,moduleSellerAnalytics:false,moduleActivityLog:false,moduleSettings:false,moduleBilling:false,
    productWrite:true,inventoryAdjust:true,transferView:true,transferCreate:true,transferApprove:false,transferReceive:true,transferCancel:false,supplierWrite:true,returns:false,expensesWrite:false,analytics:false,shiftRecon:false,billingWrite:false,inventoryCountApprove:false,closeBusinessDay:false,dataExport:false,settingsWrite:false,
  },
  PLATFORM_ADMIN: { platformAdmin:true },
});

export const PERMISSION_KEYS = Object.freeze([...new Set(
  Object.values(DEFAULT_ROLE_PERMISSIONS).flatMap((permissions)=>Object.keys(permissions))
)].filter((key)=>key!=="*"&&key!=="platformAdmin"));
export const ORGANIZATION_CONFIGURABLE_ROLES = Object.freeze([ROLES.ADMIN,ROLES.MANAGER,ROLES.CASHIER,ROLES.SALES,ROLES.WAREHOUSE]);

export function isOrganizationPermissionKey(permission){
  return PERMISSION_KEYS.includes(String(permission||""));
}

export function hasPermission(user, permission) {
  if (!user) return false;
  // Platform administration is never an organization-level permission. It must
  // not be inherited by OWNER or granted through organization overrides.
  if (permission === "platformAdmin" || permission === "*") return user.appRole === ROLES.PLATFORM_ADMIN;
  if (user.appRole === ROLES.PLATFORM_ADMIN) return false;
  if (user.appRole === ROLES.OWNER) return true;
  const overrides = user.permissionOverrides || {};
  if (Object.prototype.hasOwnProperty.call(overrides, permission)) return Boolean(overrides[permission]);
  const organizationRole = user.rolePermissions?.[user.appRole] || {};
  if (Object.prototype.hasOwnProperty.call(organizationRole, permission)) return Boolean(organizationRole[permission]);
  const defaults = DEFAULT_ROLE_PERMISSIONS[user.appRole] || {};
  return Boolean(defaults["*"] || defaults[permission]);
}
