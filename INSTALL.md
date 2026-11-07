# 安装

## 从 GitHub

```sh
dsh plugin --profile desktop add github:zxclnp0711/dsh-armor-lite
```

## 从本地目录

```sh
dsh plugin --profile desktop add /path/to/dsh-armor-lite
```

## 装完

重启 DSH 桌面端。首次安装需要让宿主重新读取 bundle 清单与客户端模块图。

重启后侧栏出现「提示词增强」入口，点开能看到人设 / 规则 / 执行契约三段配置，即安装成功。

## 卸载

```sh
dsh plugin --profile desktop remove dsh-armor-lite
```
