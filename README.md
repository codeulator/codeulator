# Codeulator

This is currently unmaintained and unsupported. Good luck!

## Getting started

1. Download [ms-vsliveshare.vsliveshare-1.0.5877.vsix](https://marketplace.visualstudio.com/items?itemName=MS-vsliveshare.vsliveshare&ssr=false#version-history), and [vscodevim.vim-1.25.2.vsix](https://marketplace.visualstudio.com/items?itemName=vscodevim.vim&ssr=false#version-history). Copy these into the `extensions` directory.

2. Build and run the Docker image:

```shell
docker build . -t sfd
docker run -it -p 3100:3100 -e SFD_ALLOW_ANONYMOUS=1 sfd
```

3. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and create a tunnel:

```shell
cloudflared tunnel --url http://localhost:3100
```

4. In ChatGPT, select the ["develop your own plugin"](https://platform.openai.com/docs/plugins/getting-started) option, and enter your Cloudflare tunnel domain.
