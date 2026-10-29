import './environment';
import { createPrismaClient } from './prismaClient';

const prisma = createPrismaClient();

export default prisma;
