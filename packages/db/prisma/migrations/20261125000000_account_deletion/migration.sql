-- DropForeignKey
ALTER TABLE "booking" DROP CONSTRAINT "booking_boatUserId_fkey";

-- CreateTable
CREATE TABLE "account_deletion_record" (
    "id" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "stripeAccountId" TEXT,
    "stripeCloseState" TEXT,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_deletion_record_pkey" PRIMARY KEY ("id")
);
