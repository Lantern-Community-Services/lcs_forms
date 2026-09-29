# Forms as code

Built forms kept as `lcs-form` JSON. Push one to the app (from `backend/`):

    npm run forms -- push ../forms/<name>.json [--publish] [--note "what changed"]

The file name is the form's URL name (`intake.json` → `/f/intake`). See the root README,
"Form builder → Forms as code", and Admin → AI form builder for the format reference.
