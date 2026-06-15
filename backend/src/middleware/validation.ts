import Joi from 'joi';
import { Request, Response, NextFunction } from 'express';
import { createError } from './errorHandler';

function validate(schema: Joi.ObjectSchema, property: 'body' | 'query' | 'params' = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const { error, value } = schema.validate(req[property], { abortEarly: false, stripUnknown: true });

    if (error) {
      const details = error.details.map((d) => ({ field: d.path.join('.'), message: d.message }));
      const err = createError(400, 'Validation failed');
      (err as any).errors = details;
      return next(err);
    }

    (req as any)[property] = value;
    next();
  };
}

// -- Schemas -------------------------------------------------------------------

const schemas = {
  registerUser: Joi.object({
    username: Joi.string().min(1).max(32).required(),
    steamId: Joi.string().max(32).optional().allow('', null),
    installToken: Joi.string().uuid().required(),
    // Fields the register controller reads from the body. These were being
    // silently dropped by stripUnknown:true (the middleware overwrites
    // req.body with the validated value), so the Discord-heal + endpoint-seed
    // paths never actually saw them. Declared optional so they survive
    // validation. publicKey enables device-keypair TOFU enrolment.
    discordId: Joi.string().max(32).optional().allow('', null),
    discordUsername: Joi.string().max(64).optional().allow('', null),
    discordAvatar: Joi.string().max(256).optional().allow('', null),
    discordDisplayName: Joi.string().max(64).optional().allow('', null),
    publicKey: Joi.string().max(512).optional().allow('', null),
  }),

  sendMessage: Joi.object({
    content: Joi.string().min(1).max(500).required(),
    channelId: Joi.string().uuid().required(),
  }),

  createChannel: Joi.object({
    name: Joi.string().min(1).max(64).required(),
    color: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).default('#18FF62'),
    parentId: Joi.string().uuid().optional().allow('', null),
    sortOrder: Joi.number().integer().min(0).default(0),
    discordRelay: Joi.boolean().default(false),
    discordChannelId: Joi.string().max(32).optional().allow('', null),
    allowGifs: Joi.boolean().default(false),
    allowEmojis: Joi.boolean().default(true),
  }),

  updateChannel: Joi.object({
    name: Joi.string().min(1).max(64).optional(),
    color: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).optional(),
    parentId: Joi.string().uuid().optional().allow('', null),
    sortOrder: Joi.number().integer().min(0).optional(),
    discordRelay: Joi.boolean().optional(),
    discordChannelId: Joi.string().max(32).optional().allow('', null),
    allowGifs: Joi.boolean().optional(),
    allowEmojis: Joi.boolean().optional(),
  }),

  submitReport: Joi.object({
    targetUserId: Joi.string().uuid().required(),
    messageId: Joi.string().uuid().optional(),
    reason: Joi.string().min(1).max(500).required(),
    notes: Joi.string().max(1000).optional().allow('', null),
  }),

  resolveReport: Joi.object({
    status: Joi.string().valid('resolved', 'dismissed', 'escalated').required(),
  }),

  muteUser: Joi.object({
    duration: Joi.number().integer().min(1).max(43200).required(), // minutes, max 30 days
    reason: Joi.string().min(1).max(500).required(),
  }),

  banUser: Joi.object({
    reason: Joi.string().min(1).max(500).required(),
  }),

  addWordFilter: Joi.object({
    phrase: Joi.string().min(1).max(500).required(),
    isRegex: Joi.boolean().default(false),
    testMode: Joi.boolean().default(false),
  }),
};

export { validate, schemas };
module.exports = { validate, schemas };
