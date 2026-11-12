/**
 * 设备风控参数采集模块。
 *
 * 提供 collect_device_info() 用于采集本机设备风控参数,跨 Windows / macOS / Linux。
 * 始终返回完整 dict,字段缺失填空字符串,函数永不抛异常。
 * 不依赖任何第三方包,仅使用 Node 内置 os。
 */

const os = require('os');

let _log_enabled = false;

/**
 * 全局开关:是否在字段采集失败时打印 warning。默认 false。
 */
function set_log_enabled(enabled) {
  _log_enabled = !!enabled;
}

function _log_warning(message) {
  if (_log_enabled) {
    console.warn(message);
  }
}

function _get_os_type() {
  try {
    // Node: 'win32' | 'darwin' | 'linux' | 'freebsd' | 'aix' | ...
    const p = os.platform();
    return ({ win32: 'windows', darwin: 'macos', linux: 'linux' })[p] || 'other';
  } catch (e) {
    _log_warning(`get_os_type failed: ${e.message}`);
    return '';
  }
}

function _get_os_version() {
  try {
    return os.release() || '';
  } catch (e) {
    _log_warning(`get_os_version failed: ${e.message}`);
    return '';
  }
}

function _get_hostname() {
  try {
    return os.hostname().toUpperCase();
  } catch (e) {
    _log_warning(`get_hostname failed: ${e.message}`);
    return '';
  }
}

function _get_cpu_id() {
  try {
    const cpus = os.cpus();
    return cpus && cpus.length ? String(cpus[0].model || '').trim() : '';
  } catch (e) {
    _log_warning(`get_cpu_id failed: ${e.message}`);
    return '';
  }
}

/**
 * 采集本机设备风控参数。
 * @returns {{osType: string, osVersion: string, hostName: string, cpuId: string}}
 *
 * 脱敏（默认开启，CRONHUB_SMS_ANON_DEVICE=0 关闭）：
 *   官方文档 4.6 明确「绝不拿服务器信息冒充用户设备」—— hostname 是
 *   LAPTOP-CHEN 这类真实机器名、cpuId 是真实 CPU 型号，上报等于把
 *   「部署在哪台机器上」交给平台风控。匿名化后用固定占位值，
 *   且对同一部署保持稳定（风控看重的是前后一致，不是真实性）。
 */
const ANON_DEVICE = String(process.env.CRONHUB_SMS_ANON_DEVICE ?? '1') !== '0';

function collect_device_info() {
  return {
    osType: _get_os_type(),
    osVersion: _get_os_version(),
    hostName: ANON_DEVICE ? 'CRONHUB-SRV' : _get_hostname(),
    cpuId: ANON_DEVICE ? 'VIRTUAL-CPU' : _get_cpu_id(),
  };
}

module.exports = {
  set_log_enabled,
  collect_device_info,
};
