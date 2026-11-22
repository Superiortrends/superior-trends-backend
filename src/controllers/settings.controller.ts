import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db.js';
import { AppError } from '../middlewares/error.middleware.js';
import { SETTING_KEYS, getSettingsMap } from '../services/settings.service.js';

const MAX_AMOUNT = 1_000_000;

/** Validates and normalises one setting value. Returns the string to store, or throws AppError. */
const normaliseSetting = (key: string, raw: unknown): string => {
  switch (key) {
    case 'cod_allowed': {
      const v = String(raw).toLowerCase();
      if (v !== 'true' && v !== 'false') throw new AppError('cod_allowed must be true or false', 400);
      return v;
    }
    case 'free_shipping_threshold':
    case 'shipping_charge': {
      const n = Number(raw);
      if (raw === '' || raw === null || !Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) {
        throw new AppError(`${key} must be a number between 0 and ${MAX_AMOUNT}`, 400);
      }
      return String(Math.round(n * 1000) / 1000);
    }
    case 'estimated_delivery_days': {
      const m = String(raw).trim().match(/^(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?$/);
      if (!m) throw new AppError('Delivery time must look like "3-5" or "2" (days)', 400);
      const min = Number(m[1]);
      const max = m[2] !== undefined ? Number(m[2]) : undefined;
      if (min < 1 || (max !== undefined && max < min)) {
        throw new AppError('Delivery time must be at least 1 day and the range must go low to high', 400);
      }
      return max !== undefined && max !== min ? `${min}-${max}` : String(min);
    }
    default:
      throw new AppError(`Unknown setting: ${key}`, 400);
  }
};

export const getSettings = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.status(200).json({ status: 'success', data: { settings: await getSettingsMap() } });
  } catch (error) {
    next(error);
  }
};

export const updateSettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return next(new AppError('Settings key-value object is required', 400));
    }

    // Only known keys, each validated — nothing else can be written into the settings table.
    const entries = Object.entries(settings as Record<string, unknown>).filter(([key]) => {
      if (!SETTING_KEYS.includes(key)) throw new AppError(`Unknown setting: ${key}`, 400);
      return true;
    });
    const normalised = entries.map(([key, val]) => [key, normaliseSetting(key, val)] as const);

    await prisma.$transaction(
      normalised.map(([key, value]) =>
        prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } }),
      ),
    );

    res.status(200).json({ status: 'success', data: { settings: await getSettingsMap() } });
  } catch (error) {
    next(error);
  }
};
