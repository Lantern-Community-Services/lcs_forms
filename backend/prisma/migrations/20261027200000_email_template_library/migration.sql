BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[EmailTemplate] (
    [id] NVARCHAR(64) NOT NULL,
    [key] NVARCHAR(64) NOT NULL,
    [name] NVARCHAR(120) NOT NULL,
    [description] NVARCHAR(300),
    [kind] NVARCHAR(16) NOT NULL CONSTRAINT [EmailTemplate_kind_df] DEFAULT 'message',
    [subject] NVARCHAR(200),
    [heading] NVARCHAR(200),
    [intro] NVARCHAR(500),
    [whatToDo] NVARCHAR(500),
    [details] NVARCHAR(200),
    [buttonLabel] NVARCHAR(60),
    [urgent] BIT NOT NULL CONSTRAINT [EmailTemplate_urgent_df] DEFAULT 0,
    [preset] NVARCHAR(64),
    [hidden] BIT NOT NULL CONSTRAINT [EmailTemplate_hidden_df] DEFAULT 0,
    [revision] INT NOT NULL CONSTRAINT [EmailTemplate_revision_df] DEFAULT 1,
    [createdByName] NVARCHAR(255),
    [updatedByName] NVARCHAR(255),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [EmailTemplate_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [EmailTemplate_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [EmailTemplate_key_key] UNIQUE NONCLUSTERED ([key])
);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

