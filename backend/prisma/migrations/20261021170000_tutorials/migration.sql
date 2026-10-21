BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[TutorialProgress] (
    [userId] NVARCHAR(64) NOT NULL,
    [key] NVARCHAR(255) NOT NULL,
    [version] INT NOT NULL CONSTRAINT [TutorialProgress_version_df] DEFAULT 1,
    [status] NVARCHAR(255) NOT NULL,
    [step] INT,
    [steps] INT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [TutorialProgress_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [TutorialProgress_pkey] PRIMARY KEY CLUSTERED ([userId],[key])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [TutorialProgress_key_idx] ON [dbo].[TutorialProgress]([key]);

-- AddForeignKey
ALTER TABLE [dbo].[TutorialProgress] ADD CONSTRAINT [TutorialProgress_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
