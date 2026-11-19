BEGIN TRY

BEGIN TRAN;

-- DropIndex
DROP INDEX [TenantProfile_headOfHouseholdId_idx] ON [dbo].[TenantProfile];

-- AlterTable
ALTER TABLE [dbo].[Site] ADD [households] BIT NOT NULL CONSTRAINT [Site_households_df] DEFAULT 0;

-- AlterTable
ALTER TABLE [dbo].[Tenant] ADD [awayReason] NVARCHAR(120),
[awaySince] DATE,
[householdHeadId] NVARCHAR(64),
[householdRelation] NVARCHAR(80),
[movedIn] BIT NOT NULL CONSTRAINT [Tenant_movedIn_df] DEFAULT 1,
[unitId] NVARCHAR(64);


-- Households now live on the resident (services/residency.ts): carry over what client information held.
-- EXEC, so the batch compiles before the new columns exist.
EXEC('UPDATE t SET t.householdHeadId = p.headOfHouseholdId, t.householdRelation = JSON_VALUE(p.data, ''$.relationshipToHead'') FROM [dbo].[Tenant] t JOIN [dbo].[TenantProfile] p ON p.tenantId = t.id WHERE ISJSON(p.data) = 1 AND (p.headOfHouseholdId IS NOT NULL OR JSON_VALUE(p.data, ''$.relationshipToHead'') IS NOT NULL)');
-- AlterTable
ALTER TABLE [dbo].[TenantProfile] DROP COLUMN [headOfHouseholdId];

-- CreateTable
CREATE TABLE [dbo].[Unit] (
    [id] NVARCHAR(64) NOT NULL,
    [siteId] NVARCHAR(64) NOT NULL,
    [label] NVARCHAR(40) NOT NULL,
    [unitType] NVARCHAR(40),
    [program] NVARCHAR(255),
    [notes] NVARCHAR(1000),
    [active] BIT NOT NULL CONSTRAINT [Unit_active_df] DEFAULT 1,
    [vacantSince] DATE,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Unit_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Unit_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Unit_siteId_label_key] UNIQUE NONCLUSTERED ([siteId],[label])
);

-- CreateTable
CREATE TABLE [dbo].[Stay] (
    [id] NVARCHAR(64) NOT NULL,
    [tenantId] NVARCHAR(64) NOT NULL,
    [siteId] NVARCHAR(64) NOT NULL,
    [unitId] NVARCHAR(64),
    [unitLabel] NVARCHAR(40),
    [program] NVARCHAR(255),
    [householdHeadId] NVARCHAR(64),
    [householdRelation] NVARCHAR(80),
    [startKind] NVARCHAR(20) NOT NULL CONSTRAINT [Stay_startKind_df] DEFAULT 'moved_in',
    [moveInDate] DATE NOT NULL,
    [moveOutDate] DATE,
    [endKind] NVARCHAR(20),
    [endReason] NVARCHAR(120),
    [exitDestination] NVARCHAR(160),
    [forwardingAddress] NVARCHAR(1000),
    [endNote] NVARCHAR(2000),
    [createdById] NVARCHAR(64),
    [endedById] NVARCHAR(64),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Stay_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Stay_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[TenantAbsence] (
    [id] NVARCHAR(64) NOT NULL,
    [tenantId] NVARCHAR(64) NOT NULL,
    [siteId] NVARCHAR(64) NOT NULL,
    [lastSeen] DATE NOT NULL,
    [reason] NVARCHAR(120) NOT NULL,
    [detail] NVARCHAR(1000),
    [expectedReturn] DATE,
    [returnedOn] DATE,
    [outcome] NVARCHAR(20),
    [remindedAt] DATETIME2,
    [createdById] NVARCHAR(64),
    [endedById] NVARCHAR(64),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [TenantAbsence_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [TenantAbsence_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[TenantTask] (
    [id] NVARCHAR(64) NOT NULL,
    [tenantId] NVARCHAR(64) NOT NULL,
    [siteId] NVARCHAR(64) NOT NULL,
    [stayId] NVARCHAR(64),
    [key] NVARCHAR(60) NOT NULL,
    [label] NVARCHAR(160) NOT NULL,
    [dueOn] DATE NOT NULL,
    [status] NVARCHAR(20) NOT NULL CONSTRAINT [TenantTask_status_df] DEFAULT 'open',
    [doneOn] DATE,
    [doneByName] NVARCHAR(255),
    [note] NVARCHAR(2000),
    [entryRef] NVARCHAR(64),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [TenantTask_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [TenantTask_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Stay_tenantId_idx] ON [dbo].[Stay]([tenantId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Stay_siteId_moveOutDate_idx] ON [dbo].[Stay]([siteId], [moveOutDate]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Stay_unitId_idx] ON [dbo].[Stay]([unitId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [TenantAbsence_tenantId_idx] ON [dbo].[TenantAbsence]([tenantId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [TenantAbsence_siteId_outcome_idx] ON [dbo].[TenantAbsence]([siteId], [outcome]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [TenantTask_siteId_status_dueOn_idx] ON [dbo].[TenantTask]([siteId], [status], [dueOn]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [TenantTask_tenantId_status_idx] ON [dbo].[TenantTask]([tenantId], [status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Tenant_unitId_idx] ON [dbo].[Tenant]([unitId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Tenant_householdHeadId_idx] ON [dbo].[Tenant]([householdHeadId]);

-- AddForeignKey
ALTER TABLE [dbo].[Tenant] ADD CONSTRAINT [Tenant_unitId_fkey] FOREIGN KEY ([unitId]) REFERENCES [dbo].[Unit]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Unit] ADD CONSTRAINT [Unit_siteId_fkey] FOREIGN KEY ([siteId]) REFERENCES [dbo].[Site]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Stay] ADD CONSTRAINT [Stay_tenantId_fkey] FOREIGN KEY ([tenantId]) REFERENCES [dbo].[Tenant]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[Stay] ADD CONSTRAINT [Stay_unitId_fkey] FOREIGN KEY ([unitId]) REFERENCES [dbo].[Unit]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[TenantAbsence] ADD CONSTRAINT [TenantAbsence_tenantId_fkey] FOREIGN KEY ([tenantId]) REFERENCES [dbo].[Tenant]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[TenantTask] ADD CONSTRAINT [TenantTask_tenantId_fkey] FOREIGN KEY ([tenantId]) REFERENCES [dbo].[Tenant]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

