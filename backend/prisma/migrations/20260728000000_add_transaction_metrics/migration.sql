-- CreateTable
CREATE TABLE "TransactionMetric" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actionId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "submittedAt" DATETIME NOT NULL,
    "confirmedAt" DATETIME,
    "indexedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "TransactionMetric_actionType_network_idx" ON "TransactionMetric"("actionType", "network");

-- CreateIndex
CREATE INDEX "TransactionMetric_submittedAt_idx" ON "TransactionMetric"("submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionMetric_actionId_key" ON "TransactionMetric"("actionId");
