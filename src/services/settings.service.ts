import { prisma } from '../config/db.js';

/** Single source of truth for store-wide settings (edited from Admin → Settings). */
export const SETTING_DEFAULTS: Record<string, string> = {
  cod_allowed: 'true',
  free_shipping_threshold: '50',
  shipping_charge: '1',
  estimated_delivery_days: '3-5',
};

export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS);

/** Defaults merged with whatever is stored in the DB. */
export const getSettingsMap = async (): Promise<Record<string, string>> => {
  const rows = await prisma.setting.findMany({ where: { key: { in: SETTING_KEYS } } });
  const map = { ...SETTING_DEFAULTS };
  for (const row of rows) map[row.key] = row.value;
  return map;
};

export type DeliverySettings = {
  threshold: number;
  charge: number;
  codAllowed: boolean;
  estimatedDays: string;
};

export const getDeliverySettings = async (): Promise<DeliverySettings> => {
  const s = await getSettingsMap();
  const threshold = Number(s.free_shipping_threshold);
  const charge = Number(s.shipping_charge);
  return {
    threshold: Number.isFinite(threshold) ? threshold : Number(SETTING_DEFAULTS.free_shipping_threshold),
    charge: Number.isFinite(charge) ? charge : Number(SETTING_DEFAULTS.shipping_charge),
    codAllowed: s.cod_allowed === 'true',
    estimatedDays: s.estimated_delivery_days,
  };
};

/** Shipping fee for a given order subtotal — the only place this rule lives on the server. */
export const computeShipping = (subtotal: number, s: Pick<DeliverySettings, 'threshold' | 'charge'>): number =>
  subtotal <= 0 || subtotal >= s.threshold ? 0 : s.charge;
