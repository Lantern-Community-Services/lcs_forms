BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[Applicant] (
    [id] NVARCHAR(64) NOT NULL,
    [siteId] NVARCHAR(64) NOT NULL,
    [program] NVARCHAR(255),
    [firstName] NVARCHAR(255) NOT NULL,
    [middleName] NVARCHAR(255),
    [lastName] NVARCHAR(255) NOT NULL CONSTRAINT [Applicant_lastName_df] DEFAULT '',
    [preferredName] NVARCHAR(255),
    [dateOfBirth] DATE,
    [phone] NVARCHAR(40),
    [email] NVARCHAR(200),
    [referralSource] NVARCHAR(80),
    [referralAgency] NVARCHAR(255),
    [referralDate] DATE,
    [eligibilityNotes] NVARCHAR(4000),
    [stage] NVARCHAR(30) NOT NULL CONSTRAINT [Applicant_stage_df] DEFAULT 'referred',
    [stageDate] DATE NOT NULL,
    [viewingDate] DATE,
    [outcomeReason] NVARCHAR(255),
    [tenantId] NVARCHAR(64),
    [version] INT NOT NULL CONSTRAINT [Applicant_version_df] DEFAULT 1,
    [createdById] NVARCHAR(64),
    [updatedById] NVARCHAR(64),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Applicant_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Applicant_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[ApplicantStep] (
    [id] NVARCHAR(64) NOT NULL,
    [applicantId] NVARCHAR(64) NOT NULL,
    [stage] NVARCHAR(30) NOT NULL,
    [date] DATE NOT NULL,
    [viewingDate] DATE,
    [reason] NVARCHAR(255),
    [note] NVARCHAR(2000),
    [byId] NVARCHAR(64),
    [byName] NVARCHAR(255) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [ApplicantStep_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [ApplicantStep_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Applicant_siteId_stage_idx] ON [dbo].[Applicant]([siteId], [stage]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Applicant_tenantId_idx] ON [dbo].[Applicant]([tenantId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ApplicantStep_applicantId_idx] ON [dbo].[ApplicantStep]([applicantId]);

-- AddForeignKey
ALTER TABLE [dbo].[ApplicantStep] ADD CONSTRAINT [ApplicantStep_applicantId_fkey] FOREIGN KEY ([applicantId]) REFERENCES [dbo].[Applicant]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

