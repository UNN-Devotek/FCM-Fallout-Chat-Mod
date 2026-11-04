import './environment';
import { createPrismaClient } from './prismaClient';
import { runtime } from '../runtime';
import { withRuntimePrisma } from '../runtime/prismaClient';

const prisma = withRuntimePrisma(createPrismaClient(), () => runtime);

export default prisma;
