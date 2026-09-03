# data/

This directory holds your private compliance data. It is gitignored by default and should never be committed to a public repository.

Copy the example files here and edit them to reflect your own compliance landscape:

```bash
cp data-example/*.yaml data/
```

Then build:

```bash
npm run build
```

The generated HTML file will land in `dist/compliance-catalog.html`.

Only this README and `.gitkeep` are tracked in the repository. Every `.yaml` file in this directory is ignored.
