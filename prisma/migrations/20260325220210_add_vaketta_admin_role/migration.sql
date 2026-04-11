-- CreateEnum
CREATE TYPE "VakettaAdminRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'SUPPORT');

-- AlterTable
ALTER TABLE "VakettaAdmin" ADD COLUMN     "role" "VakettaAdminRole" NOT NULL DEFAULT 'ADMIN';
