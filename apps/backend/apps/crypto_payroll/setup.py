from setuptools import setup, find_packages

with open("requirements.txt") as f:
    install_requires = f.read().strip().split("\n")

setup(
    name="crypto_payroll",
    version="0.1.0",
    description="Crypto-native payroll & accounting for ERPNext + Frappe HR",
    author="ChainPay",
    author_email="hello@chainpay.example",
    packages=find_packages(),
    zip_safe=False,
    include_package_data=True,
    install_requires=install_requires,
)
