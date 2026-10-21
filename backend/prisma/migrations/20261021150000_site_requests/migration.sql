BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[User] ADD [rosterEditor] BIT NOT NULL CONSTRAINT [User_rosterEditor_df] DEFAULT 0,
[locations] NVARCHAR(max);

-- AlterTable
ALTER TABLE [dbo].[UserSite] ADD [approved] BIT NOT NULL CONSTRAINT [UserSite_approved_df] DEFAULT 1;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
