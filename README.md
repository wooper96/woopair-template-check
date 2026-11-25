# WooPair league website

1. On GitHub, choose **Use this template** and create a **public** repository with `main` as its default branch.
2. In your new repository, open **Settings → Pages** and choose **GitHub Actions** as the source.
3. In WooPair, open the league setup, choose the repository, enter your league's public name, and select **Connect league**. Once the app verifies the website, the league settings will show its public address.

Invite tournament organizers as collaborators with write access. They can connect the prepared repository in WooPair and leave the new website name blank.

If setup or a tournament update is waiting for the website, use **Open Pages workflow** in WooPair to see the deployment status. Select **Run workflow** on `main` to retry the current site, then select **Check again** in WooPair.

The starter homepage shows the public tournament index and links to each event's JSON. WooPair updates `data/tournaments/` as tournaments are published.
