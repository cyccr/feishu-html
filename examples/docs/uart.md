# 串口配置示例

这个虚构的 SDK 使用 UART 输出启动日志。初始化前请让终端的波特率与设备一致。

## 接口参数

| 参数 | 示例值 | 用途 |
| --- | --- | --- |
| baud_rate | 115200 | 每秒传输的符号数 |
| data_bits | 8 | 每帧数据位数 |

### 初始化

```c
uart_config_t config = {
    .baud_rate = 115200,
    .data_bits = 8,
};
uart_init(&config);
```

[下载示例配置](/assets/uart-config.txt)
