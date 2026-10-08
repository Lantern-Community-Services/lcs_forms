BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[DevMetric] (
    [id] NVARCHAR(64) NOT NULL,
    [at] DATETIME2 NOT NULL,
    [instance] NVARCHAR(255) NOT NULL,
    [kind] NVARCHAR(64) NOT NULL,
    [name] NVARCHAR(255) NOT NULL,
    [calls] INT NOT NULL CONSTRAINT [DevMetric_calls_df] DEFAULT 0,
    [errors] INT NOT NULL CONSTRAINT [DevMetric_errors_df] DEFAULT 0,
    [rejected] INT NOT NULL CONSTRAINT [DevMetric_rejected_df] DEFAULT 0,
    [totalMs] FLOAT(53) NOT NULL CONSTRAINT [DevMetric_totalMs_df] DEFAULT 0,
    [maxMs] FLOAT(53) NOT NULL CONSTRAINT [DevMetric_maxMs_df] DEFAULT 0,
    [h0] INT NOT NULL CONSTRAINT [DevMetric_h0_df] DEFAULT 0,
    [h1] INT NOT NULL CONSTRAINT [DevMetric_h1_df] DEFAULT 0,
    [h2] INT NOT NULL CONSTRAINT [DevMetric_h2_df] DEFAULT 0,
    [h3] INT NOT NULL CONSTRAINT [DevMetric_h3_df] DEFAULT 0,
    [h4] INT NOT NULL CONSTRAINT [DevMetric_h4_df] DEFAULT 0,
    [h5] INT NOT NULL CONSTRAINT [DevMetric_h5_df] DEFAULT 0,
    [h6] INT NOT NULL CONSTRAINT [DevMetric_h6_df] DEFAULT 0,
    [h7] INT NOT NULL CONSTRAINT [DevMetric_h7_df] DEFAULT 0,
    [h8] INT NOT NULL CONSTRAINT [DevMetric_h8_df] DEFAULT 0,
    [h9] INT NOT NULL CONSTRAINT [DevMetric_h9_df] DEFAULT 0,
    [h10] INT NOT NULL CONSTRAINT [DevMetric_h10_df] DEFAULT 0,
    CONSTRAINT [DevMetric_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[DevSample] (
    [id] NVARCHAR(64) NOT NULL,
    [at] DATETIME2 NOT NULL,
    [instance] NVARCHAR(255) NOT NULL,
    [rssMb] FLOAT(53) NOT NULL,
    [heapUsedMb] FLOAT(53) NOT NULL,
    [heapTotalMb] FLOAT(53) NOT NULL,
    [cpuPct] FLOAT(53) NOT NULL,
    [loopP50Ms] FLOAT(53) NOT NULL,
    [loopP99Ms] FLOAT(53) NOT NULL,
    [loopMaxMs] FLOAT(53) NOT NULL,
    [inFlightMax] INT NOT NULL,
    [uptimeSec] INT NOT NULL,
    CONSTRAINT [DevSample_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[DevEvent] (
    [id] NVARCHAR(64) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [DevEvent_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [kind] NVARCHAR(64) NOT NULL,
    [level] NVARCHAR(16) NOT NULL CONSTRAINT [DevEvent_level_df] DEFAULT 'info',
    [instance] NVARCHAR(255),
    [path] NVARCHAR(255),
    [status] INT,
    [durationMs] FLOAT(53),
    [message] NVARCHAR(max),
    [data] NVARCHAR(max),
    [requestId] NVARCHAR(64),
    [userEmail] NVARCHAR(255),
    CONSTRAINT [DevEvent_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DevMetric_kind_at_idx] ON [dbo].[DevMetric]([kind], [at]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DevMetric_at_idx] ON [dbo].[DevMetric]([at]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DevSample_at_idx] ON [dbo].[DevSample]([at]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DevEvent_createdAt_idx] ON [dbo].[DevEvent]([createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DevEvent_kind_createdAt_idx] ON [dbo].[DevEvent]([kind], [createdAt]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
