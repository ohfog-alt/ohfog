# oh fog!

A small Jekyll blog for ideas about hacking and offensive security.

## Local Preview

Install dependencies:

```bash
bundle install
```

Run the local server:

```bash
bundle exec jekyll serve --livereload
```

Jekyll will print the local preview URL, usually `http://127.0.0.1:4000/`.

If LiveReload's port is already in use, run the preview without it:

```bash
bundle exec jekyll serve
```

## Writing

Create a new post:

```bash
bin/new-post "My Post Title"
```

Edit the generated Markdown file under `_posts/`.

## GitHub Pages

The site is configured for the future canonical domain `https://ohfog.com`.

When the repository is ready, configure GitHub Pages to deploy with GitHub Actions. The included workflow builds the site and deploys `_site` to Pages.

The root `CNAME` file contains `ohfog.com`; configure the same custom domain in GitHub Pages after DNS is ready.

## License

Written content and original creative assets are licensed under [CC BY 4.0](LICENSE).
Code is licensed under the [MIT License](LICENSE-CODE).
