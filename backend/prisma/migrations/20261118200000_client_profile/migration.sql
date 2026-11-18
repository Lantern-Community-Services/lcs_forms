BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[User] ADD [clientInfoAccess] BIT NOT NULL CONSTRAINT [User_clientInfoAccess_df] DEFAULT 0;

-- CreateTable
CREATE TABLE [dbo].[TenantProfile] (
    [tenantId] NVARCHAR(64) NOT NULL,
    [dateOfBirth] DATE,
    [ssn] NVARCHAR(9),
    [program] NVARCHAR(255),
    [caseLeadId] NVARCHAR(64),
    [headOfHouseholdId] NVARCHAR(64),
    [data] NVARCHAR(max) NOT NULL CONSTRAINT [TenantProfile_data_df] DEFAULT '{}',
    [version] INT NOT NULL CONSTRAINT [TenantProfile_version_df] DEFAULT 1,
    [updatedById] NVARCHAR(64),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [TenantProfile_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [TenantProfile_pkey] PRIMARY KEY CLUSTERED ([tenantId])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [TenantProfile_caseLeadId_idx] ON [dbo].[TenantProfile]([caseLeadId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [TenantProfile_headOfHouseholdId_idx] ON [dbo].[TenantProfile]([headOfHouseholdId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [TenantProfile_program_idx] ON [dbo].[TenantProfile]([program]);

-- AddForeignKey
ALTER TABLE [dbo].[TenantProfile] ADD CONSTRAINT [TenantProfile_tenantId_fkey] FOREIGN KEY ([tenantId]) REFERENCES [dbo].[Tenant]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

