import { z } from 'zod';

/** 后台登录（邮箱仅作账号标识，不做邮箱验证） */
export const loginSchema = z.object({
  email: z.string().email('邮箱格式不正确'),
  password: z.string().min(1, '密码不能为空'),
});

/** 修改密码：新密码强度校验（P0-A-19 AC10）在服务端做完整断言 */
export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, '原密码不能为空'),
  newPassword: z.string().min(8, '密码长度不能少于 8 位'),
});

/** 管理员重置主管密码（密码由后端随机生成，不需传入） */
export const resetPasswordSchema = z.object({
  accountId: z.string().min(1, '账号 ID 不能为空'),
});

/** 禁用后台账号 */
export const disableAccountSchema = z.object({
  accountId: z.string().min(1, '账号 ID 不能为空'),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
