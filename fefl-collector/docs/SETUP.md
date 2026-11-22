# FEFL Graphing data collector: setup (about 15 minutes, no coding)

## What this is
A small program that runs on GitHub's servers on a timer. It downloads the three public Fantasy EFL data files
(`players.json`, `squads.json`, `rounds.json`), saves a timestamped copy of everything in a database, works out the advanced
stats, and writes one file, `data/fefl-stats.json`, which your Stats tab reads. Your site never talks to Fantasy EFL directly.

## Step 1. Add the files to your repository
1. Unzip `fefl-collector.zip` on your phone or computer. You will see: `package.json`, `tsconfig.json`, `.gitignore`, `src/`, `test/`, `docs/`, `data/`, `.github/`.
2. On github.com open your repository, tap **Add file > Upload files**, drag in everything from the unzipped folder (keep the folder structure; the `.github` folder matters), and tap **Commit changes**.
   If your phone will not upload folders, use a computer, or ask GitHub's "Open in github.dev" editor to create the files.
3. Replace your site's `index.html` with the new one I gave you (it now has the Stats tab).

## Step 2. Create a free database (PostgreSQL)
1. Go to **neon.tech** and sign up (free). Create a project. Any name; choose the region closest to the UK (London or Frankfurt).
2. On the project page tap **Connect** and copy the connection string. It starts with `postgresql://` and contains your password.
   Keep it private: anyone with it can read and change your data.

## Step 3. Give GitHub the database address
1. In your repository open **Settings > Secrets and variables > Actions > New repository secret**.
2. Name: `DATABASE_URL`. Value: the connection string from step 2. Save.
3. Open **Settings > Actions > General**, scroll to **Workflow permissions**, choose **Read and write permissions**, and Save.
   (This lets the collector publish `data/fefl-stats.json` back to your repository.)

## Step 4. Run it for the first time
1. Open the **Actions** tab, choose **FEFL collector** on the left, tap **Run workflow**, tick **Force a collection**, and run it.
2. Wait about two minutes. A green tick means it worked. Open the run to read the log; the last line says how many rows were added.
3. Check that `data/fefl-stats.json` now exists in your repository. Your site rebuilds in a minute or two. Open the Stats tab.

If the run shows a red cross, copy the last 10 lines of the log and send them to me. The most likely causes are a typo in the secret, or the
permission in step 3.3 not being set.

## What happens after that, on its own
* Every 6 hours: one collection.
* On matchdays (Sun, Tue, Wed, Fri, Sat): GitHub wakes the job every 30 minutes and it collects whenever a game is on, results are settling, or a gameweek has just completed.
* Each collection saves a snapshot only for things that changed, so history builds up without waste. Nothing is ever overwritten.

## When will the "conceded" tables fill up?
The opponent tables (for example "interceptions conceded to midfielders") are built from the difference between a snapshot before a gameweek and one after it.
So they start from the first full gameweek the collector sees: after your first run you need to wait for **the next gameweek to complete**, then they appear, and they get
sharper every week. The Stats tab shows how many gameweeks they are based on. Until a club has enough games the site leans towards "average", so nothing breaks early.

## If something ever stops working
* `npm run inspect` prints what the three Fantasy EFL files look like today. If Fantasy EFL changes a field name, this shows which one.
* Actions can be switched off by GitHub after 60 days of no repository activity. The collector commits data often, so this should not happen.
* Database size: roughly 1 to 2 MB a day. Neon's free tier holds about 8 months. Ask me for a tidy-up script before then.
